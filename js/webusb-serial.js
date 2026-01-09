/**
 * WebUSBSerial - Web Serial API-like wrapper for WebUSB
 * Provides a familiar interface for serial communication over USB on Android
 * 
 * This enables ESP32Tool to work on Android devices where Web Serial API
 * is not available but WebUSB is supported.
 * 
 * IMPORTANT: For Android/Xiaomi compatibility, this class uses smaller transfer sizes
 * to prevent SLIP synchronization errors. The maxTransferSize is set to 64 bytes
 * (or endpoint packetSize if smaller) to ensure SLIP frames don't get split.
 */
class WebUSBSerial {
    constructor(logger = null) {
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
        // Transfer size optimized for WebUSB on Android/Xiaomi
        // CRITICAL: blockSize = (maxTransferSize - 2) / 2
        // Increased from 64 to 128 bytes for better performance
        // With 128 bytes: blockSize = (128-2)/2 = 63 bytes per SLIP packet
        this.maxTransferSize = 128;
        
        // Flag to indicate this is WebUSB (used by esptool to adjust block sizes)
        this.isWebUSB = true;
        
        // Command queue for serializing control transfers (critical for CP2102)
        this._commandQueue = Promise.resolve();
        
        // Logger function (defaults to console.log if not provided)
        this._log = logger || ((...args) => console.log(...args));
    }

    /**
     * Request USB device (mimics navigator.serial.requestPort())
     */
    static async requestPort(logger = null) {
        const filters = [
            { vendorId: 0x303A }, // Espressif
            { vendorId: 0x0403 }, // FTDI
            { vendorId: 0x1A86 }, // CH340
            { vendorId: 0x10C4 }, // CP210x
            { vendorId: 0x067B }  // PL2303
        ];

        const device = await navigator.usb.requestDevice({ filters });
        const port = new WebUSBSerial(logger);
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
            this._log('[WebUSB] Device already open, reconfiguring baudrate...');
            
            // Flush any pending data before reconfiguring
            try {
                // Read and discard any pending data
                let flushCount = 0;
                while (flushCount < 10) {
                    try {
                        const result = await Promise.race([
                            this.device.transferIn(this.endpointIn, this.maxTransferSize),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10))
                        ]);
                        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                            flushCount++;
                        } else {
                            break;
                        }
                    } catch (e) {
                        break; // Timeout or error means buffer is empty
                    }
                }
            } catch (e) {
                console.warn('[WebUSB] Error flushing input buffer:', e.message);
            }
            
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
                
                this._log(`[WebUSB] Reconfigured to ${baudRate} baud`);
                
                // Make sure streams are created
                if (!this.readableStream || !this.writableStream) {
                    this._createStreams();
                }
                
                return; // Success, no need to reopen
            } catch (e) {
                console.error('[WebUSB] Baudrate reconfiguration failed:', e.message);
                // Don't try to reopen, just throw the error
                throw new Error(`Unable to reconfigure baudrate: ${e.message}`);
            }
        }
        
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
//                            this._log(`[WebUSB] Endpoint packetSize=${inEp.packetSize}, using fixed maxTransferSize=${this.maxTransferSize} for better performance`);
                            // Don't limit by packetSize - use our optimized value
                        } else {
                            this._log(`[WebUSB] No packetSize found, keeping maxTransferSize=${this.maxTransferSize}`);
                        }
                    } catch (e) {
                        this._log(`[WebUSB] Error checking packetSize:`, e);
                    }

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

        // CP2102-specific initialization sequence (must be in this exact order!)
        if (this.device.vendorId === 0x10c4) {
            try {
                // Step 1: Enable UART interface
//                this._log('[WebUSB CP2102] Step 1: Enabling UART interface (IFC_ENABLE)...');
                await this.device.controlTransferOut({
                    requestType: 'vendor',
                    recipient: 'device',
                    request: 0x00, // IFC_ENABLE
                    value: 0x01,   // UART_ENABLE
                    index: 0x00
                });
//                this._log('[WebUSB CP2102] UART interface enabled');

                // Step 2: Set line control (8N1: 8 data bits, no parity, 1 stop bit)
//                this._log('[WebUSB CP2102] Step 2: Setting line control (8N1)...');
                await this.device.controlTransferOut({
                    requestType: 'vendor',
                    recipient: 'device',
                    request: 0x03, // SET_LINE_CTL
                    value: 0x0800, // 8 data bits, no parity, 1 stop bit
                    index: 0x00
                });
//                this._log('[WebUSB CP2102] Line control set');

                // Step 3: Set DTR/RTS signals (vendor-specific for CP2102)
//                this._log('[WebUSB CP2102] Step 3: Setting DTR=1, RTS=1 (SET_MHS)...');
                await this.device.controlTransferOut({
                    requestType: 'vendor',
                    recipient: 'device',
                    request: 0x07, // SET_MHS
                    value: 0x03 | 0x0100 | 0x0200, // DTR=1, RTS=1 with masks
                    index: 0x00
                });
//                this._log('[WebUSB CP2102] DTR/RTS signals set');

                // Step 4: Set baudrate (vendor-specific for CP2102)
                const baudrateValue = Math.floor(0x384000 / baudRate);
//                this._log(`[WebUSB CP2102] Step 4: Setting baudrate ${baudRate} (value=0x${baudrateValue.toString(16)})...`);
                await this.device.controlTransferOut({
                    requestType: 'vendor',
                    recipient: 'device',
                    request: 0x01, // SET_BAUDRATE
                    value: baudrateValue,
                    index: 0x00
                });
//                this._log('[WebUSB CP2102] Baudrate set successfully');
            } catch (e) {
                console.warn('[WebUSB CP2102] Initialization error:', e.message);
            }
        } else {
            // Standard CDC/ACM initialization for other chips
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

            // Initialize DTR/RTS to idle state (both HIGH/asserted)
            try {
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x22, // SET_CONTROL_LINE_STATE
                    value: 0x03, // DTR=1, RTS=1 (both asserted)
                    index: this.controlInterface || 0
                });
//                this._log('[WebUSB] Initialized DTR=1, RTS=1 (value=0x03)');
            } catch (e) {
                console.warn('Could not set control lines:', e.message);
            }
        }        // Create streams only if they don't exist yet
        if (!this.readableStream || !this.writableStream) {
            this._createStreams();
        } else {
            // Streams exist, but make sure read loop is running
            if (!this._readLoopRunning) {
//                this._log('[WebUSB] Restarting read loop...');
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
     * Get optimal block size for flash read operations
     * (maxTransferSize - 2) / 2
     * This accounts for SLIP overhead and escape sequences
     * @returns {number} Optimal block size in bytes
     */
    getOptimalReadBlockSize() {
        // Formula for WebUSB:
        // blockSize = (maxTransferSize - 2) / 2
        // -2 for SLIP frame delimiters (0xC0 at start/end)
        // /2 because worst case every byte could be escaped (0xDB 0xDC or 0xDB 0xDD)
        return Math.floor((this.maxTransferSize - 2) / 2);
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
     * CRITICAL: Commands are serialized via queue for CP2102 compatibility
     * Supports both CDC/ACM (CH343) and Vendor-Specific (CP2102, CH340)
     */
    async setSignals(signals) {
        // Serialize all control transfers through a queue
        // This is CRITICAL for CP2102 on Android - parallel commands cause hangs
        this._commandQueue = this._commandQueue.then(async () => {
            if (!this.device) {
                throw new Error('Device not open');
            }

            const vid = this.device.vendorId;
            const pid = this.device.productId;

//            this._log(`[WebUSB] setSignals called: VID=0x${vid.toString(16)}, PID=0x${pid.toString(16)}, DTR=${signals.dataTerminalReady}, RTS=${signals.requestToSend}`);

            // Detect chip type and use appropriate control request
            // CP2102 (Silicon Labs VID: 0x10c4)
            if (vid === 0x10c4) {
//                this._log('[WebUSB] Detected CP2102 - using vendor-specific request');
                return await this._setSignalsCP2102(signals);
            }
            // CH340 (WCH VID: 0x1a86, but not CH343 PID: 0x55d3)
            else if (vid === 0x1a86 && pid !== 0x55d3) {
//                this._log('[WebUSB] Detected CH340 - using vendor-specific request');
                return await this._setSignalsCH340(signals);
            }
            // CDC/ACM (CH343, Native USB, etc.)
            else {
//                this._log('[WebUSB] Detected CDC/ACM device - using standard request');
                return await this._setSignalsCDC(signals);
            }
        }).catch(err => {
            console.error('[WebUSB] setSignals error:', err);
            throw err;
        });
        
        return this._commandQueue;
    }

    /**
     * Set signals using CDC/ACM standard (for CH343, Native USB)
     */
    async _setSignalsCDC(signals) {
        let value = 0;
        value |= signals.dataTerminalReady ? 1 : 0;
        value |= signals.requestToSend ? 2 : 0;

//        this._log(`[WebUSB CDC] Setting signals: DTR=${signals.dataTerminalReady ? 1 : 0}, RTS=${signals.requestToSend ? 1 : 0}, value=0x${value.toString(16)}`);

        try {
            const result = await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22, // SET_CONTROL_LINE_STATE
                value: value,
                index: this.controlInterface || 0
            });
            
//            this._log(`[WebUSB CDC] Control transfer result: status=${result.status}`);
            await new Promise(resolve => setTimeout(resolve, 50));
            return result;
        } catch (e) {
            console.error(`[WebUSB CDC] Failed to set signals: ${e.message}`);
            throw e;
        }
    }

    /**
     * Set signals for CP2102 (Silicon Labs vendor-specific)
     */
    async _setSignalsCP2102(signals) {
        // CP2102 uses vendor-specific request 0x07 (SET_MHS)
        // Bit 0: DTR, Bit 1: RTS, Bit 8-9: DTR/RTS mask
        
        // Handle undefined values - only set what's explicitly provided
        let value = 0;
        
        if (signals.dataTerminalReady !== undefined) {
            value |= (signals.dataTerminalReady ? 1 : 0) | 0x100; // DTR + mask
        }
        
        if (signals.requestToSend !== undefined) {
            value |= (signals.requestToSend ? 2 : 0) | 0x200;     // RTS + mask
        }

//        this._log(`[WebUSB CP2102] Setting signals: DTR=${signals.dataTerminalReady}, RTS=${signals.requestToSend}, value=0x${value.toString(16)}`);

        try {
            const result = await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x07, // SET_MHS (Modem Handshaking)
                value: value,
                index: 0x00  // CP2102 always uses index 0
            });
            
//            this._log(`[WebUSB CP2102] Control transfer result: status=${result.status}`);
            await new Promise(resolve => setTimeout(resolve, 50));
            return result;
        } catch (e) {
            console.error(`[WebUSB CP2102] Failed to set signals: ${e.message}`);
            throw e;
        }
    }

    /**
     * Set signals for CH340 (WCH vendor-specific)
     */
    async _setSignalsCH340(signals) {
        // CH340 uses vendor-specific request 0xA4
        // Bit 0: DTR, Bit 1: RTS (inverted logic!)
        let value = 0;
        value |= signals.dataTerminalReady ? 0 : 0x20; // DTR (inverted)
        value |= signals.requestToSend ? 0 : 0x40;     // RTS (inverted)

//        this._log(`[WebUSB CH340] Setting signals: DTR=${signals.dataTerminalReady ? 1 : 0}, RTS=${signals.requestToSend ? 1 : 0}, value=0x${value.toString(16)}`);

        try {
            const result = await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xA4, // CH340 control request
                value: ~((signals.dataTerminalReady ? 1 << 5 : 0) | (signals.requestToSend ? 1 << 6 : 0)),
                index: 0
            });
            
//            this._log(`[WebUSB CH340] Control transfer result: status=${result.status}`);
            await new Promise(resolve => setTimeout(resolve, 50));
            return result;
        } catch (e) {
            console.error(`[WebUSB CH340] Failed to set signals: ${e.message}`);
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
                                // No delay - immediately read next packet
                                continue;
                            } else if (result.status === 'stall') {
                                await this.device.clearHalt('in', this.endpointIn);
                                await new Promise(r => setTimeout(r, 1));
                                continue;
                            }
                            // Only wait if no data was received
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
                            // Wait a bit after error before retrying
                            await new Promise(r => setTimeout(r, 10));
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
 * Unified port request function that tries WebUSB first on Android, Web Serial on Desktop
 * This provides seamless support for both desktop (Web Serial) and Android (WebUSB)
 */
async function requestSerialPort() {
    // Detect if we're on Android
    const isAndroid = /Android/i.test(navigator.userAgent);
    const hasSerial = 'serial' in navigator;
    const hasUSB = 'usb' in navigator;
    
    console.log(`[requestSerialPort] Platform: ${isAndroid ? 'Android' : 'Desktop'}, Web Serial: ${hasSerial}, WebUSB: ${hasUSB}`);
    
    // On Android, prefer WebUSB (Web Serial doesn't work properly)
    if (isAndroid && hasUSB) {
        console.log('[requestSerialPort] Using WebUSB (Android)');
        try {
            return await WebUSBSerial.requestPort();
        } catch (err) {
            console.log('WebUSB failed, trying Web Serial...', err.message);
        }
    }
    
    // Try Web Serial API (preferred on desktop)
    if (hasSerial) {
        console.log('[requestSerialPort] Using Web Serial');
        try {
            return await navigator.serial.requestPort();
        } catch (err) {
            console.log('Web Serial not available or cancelled, trying WebUSB...');
        }
    }
    
    // Fall back to WebUSB
    if (hasUSB) {
        console.log('[requestSerialPort] Using WebUSB (fallback)');
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
