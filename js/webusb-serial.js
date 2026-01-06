/**
 * WebUSBSerial - Web Serial API-like wrapper for WebUSB
 * Provides a familiar interface for serial communication over USB on Android
 * 
 * This enables ESP32Tool to work on Android devices where Web Serial API
 * is not available but WebUSB is supported.
 */
class WebUSBSerial {
    constructor() {
        this.device = null;
        this.interfaceNumber = null;
        this.endpointIn = null;
        this.endpointOut = null;
        this.controlInterface = null;
        this.readableStream = null;
        this.writableStream = null;
        this._readLoopRunning = false;
        this._usbDisconnectHandler = null;
        this._eventListeners = {
            'close': [],
            'disconnect': []
        };
        // Transfer size optimized for WebUSB on Android
        // this.maxTransferSize = 64;
        this.maxTransferSize = 0x10000;
    }

    /**
     * Request USB device (mimics navigator.serial.requestPort())
     */
    static async requestPort() {
        const filters = [
            { vendorId: 0x303A }, // Espressif
            { vendorId: 0x0403 }, // FTDI
            { vendorId: 0x1A86 }, // CH340
            { vendorId: 0x10C4 }, // CP210x
            { vendorId: 0x067B }  // PL2303
        ];

        const device = await navigator.usb.requestDevice({ filters });
        const port = new WebUSBSerial();
        port.device = device;
        return port;
    }

    /**
     * Open the USB device (mimics port.open())
     */
    async open(options = {}) {
        if (!this.device) {
            throw new Error('No device selected');
        }

        const baudRate = options.baudRate || 115200;

        // If device is already opened, just reconfigure baudrate
        if (this.device.opened) {
            console.log('[WebUSB] Device already open, reconfiguring baudrate...');
            
            // Just update line coding without closing
            try {
                const lineCoding = new Uint8Array([
                    baudRate & 0xFF,
                    (baudRate >> 8) & 0xFF,
                    (baudRate >> 16) & 0xFF,
                    (baudRate >> 24) & 0xFF,
                    0x00, // 1 stop bit
                    0x00, // No parity
                    0x08  // 8 data bits
                ]);

                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x20, // SET_LINE_CODING
                    value: 0,
                    index: this.controlInterface || 0
                }, lineCoding);
                
                console.log(`[WebUSB] Reconfigured to ${baudRate} baud`);
                
                // Also update DTR/RTS
                try {
                    await this.device.controlTransferOut({
                        requestType: 'class',
                        recipient: 'interface',
                        request: 0x22, // SET_CONTROL_LINE_STATE
                        value: 0x03, // DTR=1, RTS=1
                        index: this.controlInterface || 0
                    });
                } catch (e) {
                    console.warn('[WebUSB] Could not set control lines:', e.message);
                }
                
                // Make sure streams are created
                if (!this.readableStream || !this.writableStream) {
                    console.log('[WebUSB] Creating streams after baudrate change...');
                    this._createStreams();
                }
                
                return; // Success, no need to reopen
            } catch (e) {
                console.error('[WebUSB] Baudrate reconfiguration failed:', e.message);
                // Don't try to reopen, just throw the error
                throw new Error(`Unable to reconfigure baudrate: ${e.message}`);
            }
        }

        // Full open sequence for first time only
        console.log('[WebUSB] Opening device for first time...');
        
        if (this.device.opened) {
            try { await this.device.close(); } catch (e) { 
                console.warn('[WebUSB] Error closing device:', e.message);
            }
        }

        try { 
            if (this.device.reset) { 
                await this.device.reset(); 
            } 
        } catch (e) { 
            console.warn('[WebUSB] Device reset failed:', e.message);
        }

        const attemptOpenAndClaim = async () => {
            await this.device.open();
            try {
                const currentCfg = this.device.configuration ? this.device.configuration.configurationValue : null;
                if (!currentCfg || currentCfg !== 1) {
                    await this.device.selectConfiguration(1);
                }
            } catch (e) { }

            const config = this.device.configuration;

            // Try to claim CDC control interface first (helps on Android/CH34x)
            const preControlIface = config.interfaces.find(i => i.alternates && i.alternates[0] && i.alternates[0].interfaceClass === 0x02);
            if (preControlIface) {
                try {
                    await this.device.claimInterface(preControlIface.interfaceNumber);
                    try { await this.device.selectAlternateInterface(preControlIface.interfaceNumber, 0); } catch (e) { }
                    this.controlInterface = preControlIface.interfaceNumber;
                    console.log(`[WebUSB] Pre-claimed CDC control iface ${preControlIface.interfaceNumber}`);
                } catch (e) {
                    console.warn(`[WebUSB] Could not pre-claim CDC control iface: ${e.message}`);
                }
            }

            // Find bulk IN/OUT interface (prefer CDC data class)
            const candidates = [];
            for (const iface of config.interfaces) {
                const alt = iface.alternates[0];
                let hasIn = false, hasOut = false;
                for (const ep of alt.endpoints) {
                    if (ep.type === 'bulk' && ep.direction === 'in') hasIn = true;
                    if (ep.type === 'bulk' && ep.direction === 'out') hasOut = true;
                }
                if (hasIn && hasOut) {
                    let score = 2;
                    if (alt.interfaceClass === 0x0a) score = 0; // CDC data first
                    else if (alt.interfaceClass === 0xff) score = 1; // vendor-specific next
                    candidates.push({ iface, score });
                }
            }

            if (!candidates.length) {
                throw new Error('No suitable USB interface found');
            }

            candidates.sort((a, b) => a.score - b.score);
            let lastErr = null;
            for (const cand of candidates) {
                try {
                    try { await this.device.selectAlternateInterface(cand.iface.interfaceNumber, 0); } catch (e) { }
                    await this.device.claimInterface(cand.iface.interfaceNumber);
                    this.interfaceNumber = cand.iface.interfaceNumber;

                    const alt = cand.iface.alternates[0];
                    for (const ep of alt.endpoints) {
                        if (ep.type === 'bulk' && ep.direction === 'in') {
                            this.endpointIn = ep.endpointNumber;
                        } else if (ep.type === 'bulk' && ep.direction === 'out') {
                            this.endpointOut = ep.endpointNumber;
                        }
                    }

                    // Use endpoint packet size for transfer length (Android prefers max-packet)
                    try {
                        const inEp = alt.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'in');
                        if (inEp && inEp.packetSize) {
                            this.maxTransferSize = Math.min(inEp.packetSize, 64);
                        }
                    } catch (e) { }

                    console.log(`[WebUSB] Claimed iface ${cand.iface.interfaceNumber} with IN=${this.endpointIn} OUT=${this.endpointOut}`);
                    return config;
                } catch (claimErr) {
                    lastErr = claimErr;
                    console.warn(`[WebUSB] claim failed on iface ${cand.iface.interfaceNumber}: ${claimErr.message}`);
                }
            }

            throw lastErr || new Error('Unable to claim any USB interface');
        };

        let config;
        try {
            config = await attemptOpenAndClaim();
        } catch (err) {
            console.warn('[WebUSB] open/claim failed, retrying after reset:', err.message);
            try { if (this.device.reset) { await this.device.reset(); } } catch (e) { }
            try { await this.device.close(); } catch (e) { }
            try {
                config = await attemptOpenAndClaim();
            } catch (err2) {
                throw new Error(`Unable to claim USB interface: ${err2.message}`);
            }
        }

        // Claim control interface if not already claimed
        if (this.controlInterface == null) {
            const controlIface = config.interfaces.find(i =>
                i.alternates[0].interfaceClass === 0x02 &&
                i.interfaceNumber !== this.interfaceNumber
            );

            if (controlIface) {
                try {
                    await this.device.claimInterface(controlIface.interfaceNumber);
                    try { await this.device.selectAlternateInterface(controlIface.interfaceNumber, 0); } catch (e) { }
                    this.controlInterface = controlIface.interfaceNumber;
                } catch (e) {
                    this.controlInterface = this.interfaceNumber;
                }
            } else {
                this.controlInterface = this.interfaceNumber;
            }
        }

        // Set line coding (baudRate already declared at function start)
        try {
            const lineCoding = new Uint8Array([
                baudRate & 0xFF,
                (baudRate >> 8) & 0xFF,
                (baudRate >> 16) & 0xFF,
                (baudRate >> 24) & 0xFF,
                0x00, // 1 stop bit
                0x00, // No parity
                0x08  // 8 data bits
            ]);

            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x20, // SET_LINE_CODING
                value: 0,
                index: this.controlInterface || 0
            }, lineCoding);
        } catch (e) {
            console.warn('Could not set line coding:', e.message);
        }

        // Assert DTR/RTS
        try {
            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22, // SET_CONTROL_LINE_STATE
                value: 0x03, // DTR=1, RTS=1
                index: this.controlInterface || 0
            });
        } catch (e) {
            console.warn('Could not set control lines:', e.message);
        }

        // Create streams only if they don't exist yet
        if (!this.readableStream || !this.writableStream) {
            this._createStreams();
        } else {
            // Streams exist, but make sure read loop is running
            if (!this._readLoopRunning) {
                console.log('[WebUSB] Restarting read loop...');
                this._readLoopRunning = true;
                // Note: ReadableStream can't be restarted, we need to recreate it
                this._createStreams();
            }
        }

        // Setup disconnect handler only once
        if (!this._usbDisconnectHandler) {
            this._usbDisconnectHandler = (event) => {
                if (event.device === this.device) {
                    this._fireEvent('close');
                    this._cleanup();
                }
            };
            navigator.usb.addEventListener('disconnect', this._usbDisconnectHandler);
        }
    }

    /**
     * Close the device (mimics port.close())
     */
    async close() {
        this._cleanup();
        if (this.device) {
            try {
                if (this.interfaceNumber !== null) {
                    await this.device.releaseInterface(this.interfaceNumber);
                }
                if (this.controlInterface !== null && this.controlInterface !== this.interfaceNumber) {
                    await this.device.releaseInterface(this.controlInterface);
                }
                await this.device.close();
            } catch (e) {
                if (!e.message || !e.message.includes('disconnected')) {
                    console.warn('Error closing device:', e.message || e);
                }
            }
            // Keep device reference for potential reconfiguration
        }
    }

    /**
     * Disconnect and clear device reference (for final cleanup)
     */
    async disconnect() {
        await this.close();
        this.device = null;
    }

    /**
     * Get device info (mimics port.getInfo())
     */
    getInfo() {
        if (!this.device) {
            return {};
        }
        return {
            usbVendorId: this.device.vendorId,
            usbProductId: this.device.productId
        };
    }

    /**
     * Set DTR/RTS signals (mimics port.setSignals())
     */
    async setSignals(signals) {
        if (!this.device) {
            throw new Error('Device not open');
        }

        let value = 0;
        value |= signals.dataTerminalReady ? 1 : 0;
        value |= signals.requestToSend ? 2 : 0;

        console.log(`[WebUSB] Setting signals: DTR=${signals.dataTerminalReady ? 1 : 0}, RTS=${signals.requestToSend ? 1 : 0}, value=0x${value.toString(16)}, interface=${this.controlInterface || 0}`);

        try {
            const result = await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22, // SET_CONTROL_LINE_STATE
                value: value,
                index: this.controlInterface || 0
            });
            
            // Add delay to ensure signal is processed
            // USB-Serial chips (CP2102, CH340, etc.) need time to process control transfers
            // Increased from 10ms to 50ms for better compatibility on Android
            await new Promise(resolve => setTimeout(resolve, 50));
            
            return result;
        } catch (e) {
            console.error(`[WebUSB] Failed to set signals: ${e.message}`);
            throw e;
        }
    }

    get readable() {
        return this.readableStream;
    }

    get writable() {
        return this.writableStream;
    }

    _createStreams() {
        // ReadableStream for incoming data
        this.readableStream = new ReadableStream({
            start: async (controller) => {
                this._readLoopRunning = true;

                try {
                    while (this._readLoopRunning && this.device) {
                        try {
                            const result = await this.device.transferIn(this.endpointIn, this.maxTransferSize);

                            if (result.status === 'ok') {
                                controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
                                continue;
                            } else if (result.status === 'stall') {
                                await this.device.clearHalt('in', this.endpointIn);
                                await new Promise(r => setTimeout(r, 1));
                                continue;
                            }
                            await new Promise(r => setTimeout(r, 1));
                        } catch (error) {
                            if (error.message && (error.message.includes('device unavailable') ||
                                error.message.includes('device has been lost') ||
                                error.message.includes('device was disconnected') ||
                                error.message.includes('No device selected'))) {
                                break;
                            }
                            if (error.message && (error.message.includes('transfer was cancelled') ||
                                error.message.includes('transfer error has occurred'))) {
                                continue;
                            }
                            console.warn('USB read error:', error.message);
                        }
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    controller.close();
                }
            },
            cancel: () => {
                this._readLoopRunning = false;
            }
        });

        // WritableStream for outgoing data
        this.writableStream = new WritableStream({
            write: async (chunk) => {
                if (!this.device) {
                    throw new Error('Device not open');
                }
                await this.device.transferOut(this.endpointOut, chunk);
            }
        });
    }

    _cleanup() {
        this._readLoopRunning = false;
        if (this._usbDisconnectHandler) {
            navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler);
            this._usbDisconnectHandler = null;
        }
    }

    _fireEvent(type) {
        const listeners = this._eventListeners[type] || [];
        listeners.forEach(listener => {
            try {
                listener();
            } catch (e) {
                console.error(`Error in ${type} event listener:`, e);
            }
        });
    }

    addEventListener(type, listener) {
        if (this._eventListeners[type]) {
            this._eventListeners[type].push(listener);
        }
    }

    removeEventListener(type, listener) {
        if (this._eventListeners[type]) {
            const index = this._eventListeners[type].indexOf(listener);
            if (index !== -1) {
                this._eventListeners[type].splice(index, 1);
            }
        }
    }
}

/**
 * Unified port request function that tries Web Serial first, then falls back to WebUSB
 * This provides seamless support for both desktop (Web Serial) and Android (WebUSB)
 */
async function requestSerialPort() {
    // Try Web Serial API first (preferred on desktop)
    if ('serial' in navigator) {
        try {
            return await navigator.serial.requestPort();
        } catch (err) {
            console.log('Web Serial not available or cancelled, trying WebUSB...');
        }
    }
    
    // Fall back to WebUSB (for Android)
    if ('usb' in navigator) {
        try {
            return await WebUSBSerial.requestPort();
        } catch (err) {
            throw new Error('Neither Web Serial nor WebUSB available or user cancelled');
        }
    }
    
    throw new Error('Neither Web Serial API nor WebUSB is supported in this browser');
}

// Export as ES modules
export { WebUSBSerial, requestSerialPort };
