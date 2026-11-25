// TokenBeacon display firmware for the LILYGO T-Display-S3.
//
// Receives device-state/v1 lines over USB CDC and shows the 5-hour limit, the
// weekly limit, the context of the most recent thread and, if the host sends
// it, that thread's name. Four screens (button GPIO14: short press = next,
// long press = portrait/landscape). It never starts Wi-Fi or Bluetooth, stores
// only the orientation and shows N/A for anything the host did not send.

#include <Arduino.h>
#include <Preferences.h>
#include <TFT_eSPI.h>
#include <USB.h>

#include "tb_button.h"
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
constexpr uint8_t kBacklightLevel = 120;  // fixed; the button does not change it
constexpr uint32_t kAliveIntervalMs = 10000;
constexpr uint32_t kFrameIntervalMs = 1000;  // ages and countdowns tick in seconds
constexpr uint32_t kErrorIntervalMs = 1000;
constexpr uint32_t kSaveDelayMs = 5000;  // orientation is written to NVS 5 s after the last change

USBCDC usbSerial;
tb::TxQueue txQueue;
TFT_eSPI tft;
tb::LineBuffer lineBuffer;
tb::DisplayModel model;
char deviceId[9] = "00000000";
bool hostConnected = false;
ui::Screen screen = ui::Screen::Overview;
bool landscape = false;
tb::Button button;
tb::DeferredWrite saveOrientation(kSaveDelayMs);
Preferences settings;
uint32_t lastAliveMs = 0;
uint32_t lastFrameMs = 0;
uint32_t lastErrorMs = 0;
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

void handleButton(uint32_t now) {
  switch (button.update(digitalRead(kPinButton) == LOW, now)) {
    case tb::Button::Event::Short:
      screen = static_cast<ui::Screen>((static_cast<uint8_t>(screen) + 1) % ui::kScreenCount);
      dirty = true;
      break;
    case tb::Button::Event::Long:
      landscape = !landscape;
      ui::setOrientation(tft, landscape);
      saveOrientation.changed(now);
      dirty = true;
      break;
    case tb::Button::Event::None:
      break;
  }
  if (saveOrientation.due(now)) settings.putUChar("orient", landscape ? 1 : 0);
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
  // The default 256-byte receive queue is smaller than a state line with a
  // thread title (up to 512 bytes); a line that arrives while a frame is drawn
  // would lose bytes and the data would turn stale. Room for several lines:
  usbSerial.setRxBufferSize(2048);
  usbSerial.begin();
  USB.begin();

  // Only the orientation is stored (NVS namespace "tb"); never any data from the host.
  settings.begin("tb", false);
  landscape = settings.getUChar("orient", 0) == 1;

  tft.init();
  ledcSetup(kBacklightChannel, 2000, 8);
  ledcAttachPin(kPinBacklight, kBacklightChannel);
  ledcWrite(kBacklightChannel, kBacklightLevel);
  ui::begin(tft, landscape);
}

void loop() {
  const uint32_t now = millis();
  readUsb();
  drainTx();
  handleButton(now);

  if (!usbSerial && hostConnected) {  // port closed by the host
    hostConnected = false;
    model.onHostGone();
    dirty = true;
  }
  if (hostConnected && now - lastAliveMs >= kAliveIntervalMs) {
    lastAliveMs = now;
    char line[80];
    send(line, tb::buildAlive(line, sizeof(line), model.lastSeq() < 0 ? 0 : model.lastSeq(), now / 1000));
  }
  if (dirty || now - lastFrameMs >= kFrameIntervalMs) {
    lastFrameMs = now;
    dirty = false;
    ui::Frame frame;
    frame.screen = screen;
    frame.landscape = landscape;
    frame.hostConnected = hostConnected;
    frame.firmware = TB_FW_VERSION;
    ui::render(tft, model, now, frame);
  }
  delay(5);
}
