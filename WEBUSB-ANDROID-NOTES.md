# WebUSB on Android - Implementation Notes

## 📚 Based on Research

This implementation is based on extensive research by g3gg0:
https://www.g3gg0.de/programming/esp32-webserial-webusb-another-rabbit-hole/

## 🐛 Known Issues & Solutions

### 1. Stub Loader 0xC0 Flush Bug

**Problem:**
- Original stub loaders flush USB buffer on every 0xC0 byte
- This causes 3 USB bulk transfers instead of 1 for each response
- WebUSB can lose transfers if not queued fast enough

**Solution:**
✅ **FIXED** - Using patched stub loaders that only flush on frame end

### 2. USB Bulk Transfer Size

**Problem:**
- Large transfers (64KB) can cause data loss on Android
- Multiple small transfers arrive faster than WebUSB can queue new reads

**Solution:**
✅ Using 512 byte transfers (good balance with patched stub loaders)

**Configuration:**
```javascript
this.maxTransferSize = 512; // Optimized for Android
```

### 3. DTR/RTS Reset Timing

**Problem:**
- USB-Serial chips (CP2102, CH340) need time to process control transfers
- Android USB stack is slower than desktop
- Too fast signal changes are ignored

**Solution:**
✅ 50ms delay after each `setSignals()` call

**Code:**
```javascript
async setSignals(signals) {
    await this.device.controlTransferOut({
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: value,
        index: this.controlInterface || 0
    });
    
    // 50ms delay for USB-Serial chips
    await new Promise(resolve => setTimeout(resolve, 50));
}
```

### 4. Stream Management

**Problem:**
- Streams not created after baudrate change
- Read loop stops after first connection

**Solution:**
✅ Check and recreate streams when needed

**Code:**
```javascript
if (!this.readableStream || !this.writableStream) {
    console.log('[WebUSB] Creating streams...');
    this._createStreams();
}
```

## 🔧 Current Implementation Status

### ✅ Working:
- CDC/JTAG (ESP32-S2, S3, C3, C6) - Native USB
- Baudrate changes
- Flash reading/writing
- Stream management

### ⚠️ Partially Working:
- USB-Serial chips (CP2102, CH340, FTDI)
  - Communication works
  - Reset can be unreliable
  - May need manual BOOT button press

### ❌ Known Limitations:
- iOS not supported (no WebUSB)
- Firefox not supported (no WebUSB)
- Some Android devices don't support USB OTG
- Some USB-Serial chips have timing issues

## 📊 Tested Configurations

| Device | Chip | Android | Status |
|--------|------|---------|--------|
| ESP32-S3 | Native USB | ✅ | Works perfectly |
| ESP32-C3 | Native USB | ✅ | Works perfectly |
| ESP32-C6 | Native USB | ✅ | Works perfectly |
| ESP32 | CP2102 | ⚠️ | Reset unreliable |
| ESP32 | CH340 | ⚠️ | Reset unreliable |
| ESP32 | FTDI | ⚠️ | Reset unreliable |

## 🎯 Recommendations

### For Best Experience:
1. **Use ESP32-S3/C3/C6** with native USB (CDC/JTAG)
2. **Use patched stub loaders** (already included)
3. **Use good quality USB OTG cable**
4. **Keep baudrate at 115200** for initial connection
5. **Increase to 921600** for flashing (if stable)

### For USB-Serial Chips:
1. **Start with 115200 baud**
2. **Press BOOT button manually** if reset fails
3. **Use shorter USB cable** (< 1m)
4. **Try different USB OTG adapters**

## 🔍 Debugging

### Enable Verbose Logging:
Check browser console for:
```
[WebUSB] Device already open, reconfiguring baudrate...
[WebUSB] Reconfigured to 921600 baud
[WebUSB] Setting signals: DTR=0, RTS=1, value=0x2, interface=0
[WebUSB] Creating streams after baudrate change...
```

### Common Issues:

**"Timeout waiting for packet header"**
- Streams not created → Check if streams are initialized
- Transfer size too large → Already fixed (512 bytes)
- Stub loader bug → Already fixed (patched loaders)

**"Trying Classic reset" hangs**
- DTR/RTS timing → Already fixed (50ms delay)
- Wrong interface → Check `controlInterface` value
- USB-Serial chip issue → Try manual BOOT button

**"No device selected"**
- Device reference lost → Already fixed (keep reference)
- Port closed incorrectly → Already fixed (don't set null)

## 📝 Implementation Details

### Transfer Size Calculation:
```javascript
// With patched stub loaders:
maxTransferSize = 512; // Good balance

// Without patched stub loaders (original):
maxTransferSize = 64;  // Catch all small transfers
```

### Reset Sequence:
```javascript
// Classic Reset (USB-Serial chips):
setDTR(false), setRTS(true)  → EN=LOW (Reset)
wait 100ms
setDTR(true), setRTS(false)  → EN=HIGH, IO0=LOW (Bootloader)
wait 50ms
setDTR(false)                → IO0=HIGH (Normal)
wait 200ms

// Each setSignals() has 50ms internal delay
```

### Control Interface Selection:
```javascript
// Priority:
1. CDC Control Interface (class 0x02)
2. CDC Data Interface (class 0x0a)
3. Vendor-specific (class 0xff)
4. Fallback to interface 0
```

## 🚀 Future Improvements

### Possible Enhancements:
1. **Chip-specific delays** (CH340 needs more time)
2. **Retry mechanism** for control transfers
3. **Auto-detect optimal transfer size**
4. **Better error messages** for users

### Not Planned:
- iOS support (WebUSB not available)
- Firefox support (WebUSB not available)
- Accessory Mode (not needed for OTG)

## 📚 References

- [g3gg0's WebUSB Research](https://www.g3gg0.de/programming/esp32-webserial-webusb-another-rabbit-hole/)
- [g3gg0's ESP32 Flasher](https://github.com/g3gg0/esp32_flasher)
- [WebUSB Specification](https://wicg.github.io/webusb/)
- [USB CDC Class](https://www.usb.org/document-library/class-definitions-communication-devices-12)
- [ESP-IDF USB Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/usb-serial-jtag-console.html)

## 🙏 Credits

- **g3gg0** for extensive WebUSB research and stub loader patches
- **Espressif** for esptool.py and stub loaders
- **Adafruit/Nabu Casa** for original ESP32Tool

---

**Last Updated:** January 2026
**Implementation:** espWebAndroid/js/webusb-serial.js
