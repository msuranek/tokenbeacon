#include "tb_protocol.h"

#include <ArduinoJson.h>
#include <stdio.h>
#include <string.h>

namespace tb {
namespace {

// Feeds ArduinoJson and remembers how far it read, so trailing content after
// the object can be rejected like JSON.parse does on the host.
class CountingReader {
 public:
  CountingReader(const char* data, size_t length) : data_(data), length_(length) {}
  int read() { return position_ < length_ ? static_cast<unsigned char>(data_[position_++]) : -1; }
  size_t readBytes(char* buffer, size_t count) {
    size_t n = 0;
    while (n < count && position_ < length_) buffer[n++] = data_[position_++];
    return n;
  }
  size_t position() const { return position_; }

 private:
  const char* data_;
  size_t length_;
  size_t position_ = 0;
};

bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

bool hasKey(JsonObjectConst object, const char* key) {
  for (JsonPairConst pair : object) {
    if (strcmp(pair.key().c_str(), key) == 0) return true;
  }
  return false;
}

bool readInteger(JsonVariantConst value, int64_t min, int64_t max, int64_t& out) {
  if (!value.is<int64_t>()) return false;
  const int64_t number = value.as<int64_t>();
  if (number < min || number > max) return false;
  out = number;
  return true;
}

bool matches(const char* text, size_t minLength, size_t maxLength, bool (*allowed)(char)) {
  if (text == nullptr) return false;
  const size_t length = strlen(text);
  if (length < minLength || length > maxLength) return false;
  for (size_t i = 0; i < length; i++) {
    if (!allowed(text[i])) return false;
  }
  return true;
}

bool versionChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '+' || c == '-';
}

bool lowerHexChar(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }

bool readState(JsonVariantConst value, ValueState& out) {
  const char* st = value.as<const char*>();
  if (!value.is<const char*>() || st == nullptr) return false;
  if (strcmp(st, "current") == 0) out = ValueState::Current;
  else if (strcmp(st, "last-known") == 0) out = ValueState::LastKnown;
  else if (strcmp(st, "unavailable") == 0) out = ValueState::Unavailable;
  else return false;
  return true;
}

bool readOptionalCount(JsonObjectConst object, const char* key, int64_t& out) {
  if (!hasKey(object, key)) {
    out = -1;
    return true;
  }
  return readInteger(object[key], 0, kMaxCount, out);
}

bool readLimit(JsonVariantConst value, LimitValue& out) {
  out = LimitValue();
  if (!value.is<JsonObjectConst>()) return false;
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!readState(object["st"], out.st)) return false;
  if (out.st == ValueState::Unavailable) return true;  // other fields are ignored
  if (!readOptionalCount(object, "age", out.age)) return false;
  const char* win = object["win"].as<const char*>();
  if (object["win"].is<const char*>() && win != nullptr && strcmp(win, "expired") == 0) {
    if (hasKey(object, "left")) return false;  // an ended window never carries a percentage
    out.win = Window::Expired;
    return true;
  }
  if (!object["win"].is<const char*>() || win == nullptr || strcmp(win, "active") != 0) return false;
  int64_t left = 0;
  if (!readInteger(object["left"], 0, 100, left)) return false;
  if (!readOptionalCount(object, "reset", out.reset)) return false;
  out.win = Window::Active;
  out.left = static_cast<int16_t>(left);
  return true;
}

bool readContext(JsonVariantConst value, ContextValue& out) {
  out = ContextValue();
  if (!value.is<JsonObjectConst>()) return false;
  JsonObjectConst object = value.as<JsonObjectConst>();
  if (!readState(object["st"], out.st)) return false;
  if (out.st == ValueState::Unavailable) return true;
  int64_t used = 0;
  if (!readInteger(object["used"], 0, 100, used)) return false;
  if (!readOptionalCount(object, "age", out.age)) return false;
  out.used = static_cast<int16_t>(used);
  // Optional thread title: kept only when it is valid as a whole (never cut here).
  JsonVariantConst title = object["title"];
  if (!title.isUnbound()) {
    if (!title.is<JsonString>()) return false;
    const JsonString text = title.as<JsonString>();
    if (!isTitleText(text.c_str(), text.size())) return false;
    memcpy(out.title, text.c_str(), text.size());
    out.title[text.size()] = '\0';
  }
  return true;
}

}  // namespace

const char* errorCode(ParseError error) {
  switch (error) {
    case ParseError::None: return "ok";
    case ParseError::LineTooLong: return "line_too_long";
    case ParseError::BadJson: return "bad_json";
    case ParseError::UnsupportedVersion: return "unsupported_version";
    case ParseError::UnknownType: return "unknown_type";
    case ParseError::BadField: return "bad_field";
  }
  return "bad_field";
}

ParseError parseHostLine(const char* line, size_t length, HostMessage& out) {
  if (line == nullptr) return ParseError::BadJson;
  if (length > kMaxLineBytes) return ParseError::LineTooLong;

  JsonDocument document;
  CountingReader reader(line, length);
  if (deserializeJson(document, reader) != DeserializationError::Ok) return ParseError::BadJson;
  for (size_t i = reader.position(); i < length; i++) {
    if (!isSpace(line[i])) return ParseError::BadJson;
  }
  if (!document.is<JsonObjectConst>()) return ParseError::BadJson;
  JsonObjectConst object = document.as<JsonObjectConst>();

  if (!object["tb"].is<int64_t>()) return ParseError::BadField;
  if (object["tb"].as<int64_t>() != 1) return ParseError::UnsupportedVersion;
  if (!object["t"].is<const char*>()) return ParseError::BadField;
  const char* type = object["t"].as<const char*>();

  if (strcmp(type, "hello") == 0) {
    const char* host = object["host"].as<const char*>();
    const char* ver = object["ver"].as<const char*>();
    const char* nonce = object["nonce"].as<const char*>();
    if (host == nullptr || strcmp(host, "tokenbeacon") != 0) return ParseError::BadField;
    if (!object["ver"].is<const char*>() || !matches(ver, 1, 32, versionChar)) return ParseError::BadField;
    if (!object["nonce"].is<const char*>() || !matches(nonce, 8, 32, lowerHexChar)) return ParseError::BadField;
    out = HostMessage();
    out.type = HostMessageType::Hello;
    strncpy(out.hello.ver, ver, sizeof(out.hello.ver) - 1);
    strncpy(out.hello.nonce, nonce, sizeof(out.hello.nonce) - 1);
    return ParseError::None;
  }

  if (strcmp(type, "state") == 0) {
    StateMessage state;
    int64_t next = 0;
    if (!readInteger(object["seq"], 0, kMaxCount, state.seq)) return ParseError::BadField;
    if (!readLimit(object["five"], state.five)) return ParseError::BadField;
    if (!readLimit(object["week"], state.week)) return ParseError::BadField;
    if (!readContext(object["ctx"], state.ctx)) return ParseError::BadField;
    if (!readInteger(object["next"], 1, 60, next)) return ParseError::BadField;
    state.next = static_cast<int16_t>(next);
    out = HostMessage();
    out.type = HostMessageType::State;
    out.state = state;
    return ParseError::None;
  }

  return ParseError::UnknownType;
}

size_t buildHello(char* out, size_t capacity, const char* nonce, const char* firmware, const char* deviceId) {
  const int n = snprintf(out, capacity,
                         "{\"tb\":1,\"t\":\"hello\",\"dev\":\"%s\",\"fw\":\"%s\",\"proto\":[1],\"caps\":[\"title\"],\"nonce\":\"%s\",\"id\":\"%s\"}\n",
                         kDeviceName, firmware, nonce, deviceId);
  return n > 0 && static_cast<size_t>(n) < capacity ? static_cast<size_t>(n) : 0;
}

size_t buildAlive(char* out, size_t capacity, int64_t seq, uint32_t uptimeSeconds) {
  const int n = snprintf(out, capacity, "{\"tb\":1,\"t\":\"alive\",\"seq\":%lld,\"up\":%lu}\n", static_cast<long long>(seq),
                         static_cast<unsigned long>(uptimeSeconds));
  return n > 0 && static_cast<size_t>(n) < capacity ? static_cast<size_t>(n) : 0;
}

size_t buildError(char* out, size_t capacity, ParseError error) {
  const int n = snprintf(out, capacity, "{\"tb\":1,\"t\":\"err\",\"code\":\"%s\"}\n", errorCode(error));
  return n > 0 && static_cast<size_t>(n) < capacity ? static_cast<size_t>(n) : 0;
}

void deviceIdFromMac(uint64_t mac, char out[9]) {
  // FNV-1a over the six MAC bytes with a fixed prefix: stable per board, not reversible to the MAC.
  uint32_t hash = 2166136261u;
  const char* prefix = "tokenbeacon";
  for (const char* p = prefix; *p; p++) hash = (hash ^ static_cast<uint8_t>(*p)) * 16777619u;
  for (int i = 0; i < 6; i++) hash = (hash ^ static_cast<uint8_t>(mac >> (8 * i))) * 16777619u;
  snprintf(out, 9, "%08lx", static_cast<unsigned long>(hash));
}

}  // namespace tb
