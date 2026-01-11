# WebUSB on Android - Implementation Notes

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

## 🔧 Current Implementation Status

### ✅ Working:
- CDC/JTAG (ESP32-S2, S3, C3, C6) - Native USB
- Baudrate changes
- Flash reading/writing
- Stream management
- USB-Serial chips (CP2102, CH340, FTDI)

### ❌ Known Limitations:
- iOS not supported (no WebUSB)
- Firefox not supported (no WebUSB)
- Some Android devices don't support USB OTG
- Some USB-Serial chips have timing issues

## 📊 Tested Configurations

| Device | Chip | Android | Status |
|--------|------|---------|--------|
| ESP32-S2 | Native USB | ✅ | Works perfectly |
| ESP32-S3 | Native USB | ✅ | Works perfectly |
| ESP32-C3 | Native USB | ✅ | Works perfectly |
| ESP32-C5 | Native USB | ✅ | Works perfectly |
| ESP32-C6 | Native USB | ✅ | Works perfectly |
| ESP32-H2 | Native USB | ✅ | Works perfectly |
| ESP32 | CH343 | ✅ | Works |
| ESP32 | CH340 | ✅ | Works |
| ESP32 | CP2102 | ✅ | Works |
| ESP32 | FTDI | ✅ | Works |

## 🎯 Recommendations

### For Best Experience:
1. **Use ESP32-S3/C3/C6** with native USB (CDC/JTAG)
2. **Use patched stub loaders** (already included)
3. **Use good quality USB OTG cable**

### For USB-Serial Chips:
1. **Start with 115200 baud**
2. **Use shorter USB cable** (< 1m)
3. **Try different USB OTG adapters**

### Common Issues:

**"Timeout waiting for packet header"**
- Streams not created → Check if streams are initialized
- Transfer size too large → Already fixed (512 bytes)
- Stub loader bug → Already fixed (patched loaders)

**"Trying Classic reset" hangs**
- DTR/RTS timing → Already fixed (50ms delay)
- Wrong interface → Check `controlInterface` value
- USB-Serial chip issue → Try manual BOOT button

## 📝 Implementation Details

### Transfer Size Calculation:
```javascript
// With patched stub loaders:
maxTransferSize = 512; // Good balance

// Without patched stub loaders (original):
maxTransferSize = 64;  // Catch all small transfers
```

### Not Planned:
- iOS support (WebUSB not available)
- Firefox support (WebUSB not available)
- Accessory Mode (not needed for OTG)

## 📚 References
- [g3gg0's ESP32 Flasher](https://github.com/g3gg0/esp32_flasher)
- [WebUSB Specification](https://wicg.github.io/webusb/)
- [USB CDC Class](https://www.usb.org/document-library/class-definitions-communication-devices-12)
- [ESP-IDF USB Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/usb-serial-jtag-console.html)

## 🙏 Credits

- **g3gg0** for WebUSB research and stub loader patches
- **Espressif** for esptool.py and stub loaders
- **Adafruit/Nabu Casa** for original ESP32Tool

---

**Last Updated:** January 2026
**Implementation:** js/webusb-serial.js
