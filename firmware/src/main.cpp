// TokenBeacon display firmware for the LILYGO T-Display-S3.
//
// Receives device-state/v1 lines over USB CDC and shows the 5-hour limit, the
// weekly limit and the context of the active thread. It never starts Wi-Fi or
// Bluetooth, stores nothing and shows N/A for anything the host did not send.

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <USB.h>

#include "tb_line_buffer.h"
#include "tb_model.h"
#include "tb_protocol.h"
#include "tb_tx_queue.h"
#include "ui.h"

#ifndef TB_FW_VERSION
#define TB_FW_VERSION "0.0.0"
#endif

namespace {

constexpr int kPinPowerOn = 15;  // LCD and peripheral power: must be HIGH
constexpr int kPinBacklight = 38;
constexpr int kPinButton = 14;  // user button; GPIO0 (BOOT) is left alone
constexpr int kBacklightChannel = 0;
constexpr uint8_t kBrightness[] = {40, 120, 255};
constexpr uint32_t kAliveIntervalMs = 10000;
constexpr uint32_t kFrameIntervalMs = 250;
constexpr uint32_t kErrorIntervalMs = 1000;
// Screen orientation: portrait. Which way the USB-C port points is checked on
// the real board (phase D); 2 turns the picture by 180 degrees.
constexpr uint8_t kRotation = 0;

USBCDC usbSerial;
tb::TxQueue txQueue;
TFT_eSPI tft;
tb::LineBuffer lineBuffer;
tb::DisplayModel model;
char deviceId[9] = "00000000";
bool hostConnected = false;
uint8_t brightness = 2;
uint32_t lastAliveMs = 0;
uint32_t lastFrameMs = 0;
uint32_t lastErrorMs = 0;
bool buttonWasDown = false;
uint32_t buttonChangedMs = 0;
bool dirty = true;

// The CDC transmit FIFO holds 64 bytes: lines are queued and drained in
// pieces that fit, never blocking the screen (see tb_tx_queue.h).
void send(const char* line, size_t length) {
  if (usbSerial) txQueue.push(line, length);
}

void drainTx() {
  if (!usbSerial) {
    txQueue.clear();
    return;
  }
  const int space = usbSerial.availableForWrite();
  if (space <= 0 || txQueue.pending() == 0) return;
  const char* data = nullptr;
  const size_t count = txQueue.peek(static_cast<size_t>(space), &data);
  txQueue.consume(usbSerial.write(reinterpret_cast<const uint8_t*>(data), count));
}

void sendError(tb::ParseError error) {
  const uint32_t now = millis();
  if (now - lastErrorMs < kErrorIntervalMs) return;  // never flood the host
  lastErrorMs = now;
  char line[64];
  send(line, tb::buildError(line, sizeof(line), error));
}

void handleLine(const char* text, size_t length) {
  tb::HostMessage message;
  const tb::ParseError error = tb::parseHostLine(text, length, message);
  if (error != tb::ParseError::None) {
    sendError(error);
    return;
  }
  const uint32_t now = millis();
  if (message.type == tb::HostMessageType::Hello) {
    char line[160];
    send(line, tb::buildHello(line, sizeof(line), message.hello.nonce, TB_FW_VERSION, deviceId));
    model.onHostHello(now);
    hostConnected = true;
  } else if (model.apply(message.state, now)) {
    hostConnected = true;
  }
  dirty = true;
}

void readUsb() {
  int budget = 1024;  // keep the screen responsive under load
  while (usbSerial.available() > 0 && budget-- > 0) {
    const int byte = usbSerial.read();
    if (byte < 0) break;
    switch (lineBuffer.push(static_cast<uint8_t>(byte))) {
      case tb::LineBuffer::Event::Line:
        handleLine(lineBuffer.line(), lineBuffer.length());
        break;
      case tb::LineBuffer::Event::TooLong:
        sendError(tb::ParseError::LineTooLong);
        break;
      case tb::LineBuffer::Event::None:
        break;
    }
  }
}

void setBacklight() { ledcWrite(kBacklightChannel, kBrightness[brightness]); }

void readButton(uint32_t now) {
  const bool down = digitalRead(kPinButton) == LOW;
  if (down != buttonWasDown && now - buttonChangedMs > 30) {
    buttonChangedMs = now;
    buttonWasDown = down;
    if (down) {
      brightness = static_cast<uint8_t>((brightness + 1) % sizeof(kBrightness));
      setBacklight();
    }
  }
}

}  // namespace

void setup() {
  pinMode(kPinPowerOn, OUTPUT);
  digitalWrite(kPinPowerOn, HIGH);
  pinMode(kPinButton, INPUT_PULLUP);

  tb::deviceIdFromMac(ESP.getEfuseMac(), deviceId);

  // USB identity: TokenBeacon only opens ports with this product name.
  USB.productName("TokenBeacon Display");
  USB.manufacturerName("TokenBeacon");
  USB.serialNumber(deviceId);
  usbSerial.begin();
  USB.begin();

  tft.init();
  tft.setRotation(kRotation);
  ledcSetup(kBacklightChannel, 2000, 8);
  ledcAttachPin(kPinBacklight, kBacklightChannel);
  setBacklight();
  ui::begin(tft);
}

void loop() {
  const uint32_t now = millis();
  readUsb();
  drainTx();
  readButton(now);

  if (!usbSerial) hostConnected = false;  // port closed by the host
  if (hostConnected && now - lastAliveMs >= kAliveIntervalMs) {
    lastAliveMs = now;
    char line[80];
    send(line, tb::buildAlive(line, sizeof(line), model.lastSeq() < 0 ? 0 : model.lastSeq(), now / 1000));
  }
  if (dirty || now - lastFrameMs >= kFrameIntervalMs) {
    lastFrameMs = now;
    dirty = false;
    ui::render(tft, model, now, hostConnected, TB_FW_VERSION);
  }
  delay(5);
}
