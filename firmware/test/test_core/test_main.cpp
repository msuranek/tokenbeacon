// Host tests for the portable display core. The protocol rules are checked
// against the same vectors as TokenBeacon itself (tests/device-vectors).

#include <ArduinoJson.h>
#include <unity.h>

#include <fstream>
#include <string>
#include <vector>

#include "tb_format.h"
#include "tb_line_buffer.h"
#include "tb_model.h"
#include "tb_protocol.h"
#include "tb_tx_queue.h"

using namespace tb;

static std::vector<std::string> readLines(const char* name) {
  std::ifstream file(std::string(TB_VECTORS_DIR) + "/" + name);
  TEST_ASSERT_TRUE_MESSAGE(file.good(), name);
  std::vector<std::string> lines;
  std::string line;
  while (std::getline(file, line)) {
    if (!line.empty()) lines.push_back(line);
  }
  return lines;
}

static std::string readFile(const char* name) {
  std::ifstream file(std::string(TB_VECTORS_DIR) + "/" + name);
  TEST_ASSERT_TRUE_MESSAGE(file.good(), name);
  return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

void setUp() {}
void tearDown() {}

// --- protocol -----------------------------------------------------------------

void test_host_vectors() {
  const std::vector<std::string> vectors = readLines("host-to-device.jsonl");
  TEST_ASSERT_GREATER_OR_EQUAL(20, vectors.size());
  for (const std::string& vector : vectors) {
    JsonDocument doc;
    TEST_ASSERT_EQUAL(DeserializationError::Ok, deserializeJson(doc, vector).code());
    const std::string line = doc["line"].as<std::string>();
    const std::string expect = doc["expect"].as<std::string>();
    const std::string note = doc["note"].as<std::string>();
    HostMessage message;
    const ParseError error = parseHostLine(line.data(), line.size(), message);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(expect.c_str(), errorCode(error), note.c_str());
  }
}

void test_state_cases_parse_to_the_encoded_values() {
  JsonDocument doc;
  TEST_ASSERT_EQUAL(DeserializationError::Ok, deserializeJson(doc, readFile("state-cases.json")).code());
  JsonArrayConst cases = doc["cases"].as<JsonArrayConst>();
  TEST_ASSERT_GREATER_OR_EQUAL(5, cases.size());
  for (JsonObjectConst testCase : cases) {
    const std::string line = testCase["expected"].as<std::string>() + "\n";
    HostMessage message;
    TEST_ASSERT_EQUAL_STRING_MESSAGE("ok", errorCode(parseHostLine(line.data(), line.size(), message)),
                                     testCase["name"].as<const char*>());
    TEST_ASSERT_EQUAL(HostMessageType::State, message.type);
    TEST_ASSERT_EQUAL_INT64(testCase["seq"].as<int64_t>(), message.state.seq);
  }
  // First case in detail.
  const std::string line = cases[0]["expected"].as<std::string>() + "\n";
  HostMessage message;
  parseHostLine(line.data(), line.size(), message);
  const StateMessage& s = message.state;
  TEST_ASSERT_EQUAL(ValueState::LastKnown, s.five.st);
  TEST_ASSERT_EQUAL(Window::Active, s.five.win);
  TEST_ASSERT_EQUAL(58, s.five.left);
  TEST_ASSERT_EQUAL_INT64(7920, s.five.reset);
  TEST_ASSERT_EQUAL_INT64(312, s.five.age);
  TEST_ASSERT_EQUAL(37, s.week.left);
  TEST_ASSERT_EQUAL(ValueState::Current, s.ctx.st);
  TEST_ASSERT_EQUAL(46, s.ctx.used);
  TEST_ASSERT_EQUAL_INT64(4, s.ctx.age);
  TEST_ASSERT_EQUAL(10, s.next);
}

void test_host_hello_is_read() {
  const char* line = "{\"tb\":1,\"t\":\"hello\",\"host\":\"tokenbeacon\",\"ver\":\"0.3.0\",\"nonce\":\"5f1c9a2e\"}\n";
  HostMessage message;
  TEST_ASSERT_EQUAL(ParseError::None, parseHostLine(line, strlen(line), message));
  TEST_ASSERT_EQUAL(HostMessageType::Hello, message.type);
  TEST_ASSERT_EQUAL_STRING("5f1c9a2e", message.hello.nonce);
  TEST_ASSERT_EQUAL_STRING("0.3.0", message.hello.ver);
}

void test_trailing_content_and_null_fields_are_rejected() {
  HostMessage message;
  const char* trailing = "{\"tb\":1,\"t\":\"hello\",\"host\":\"tokenbeacon\",\"ver\":\"1\",\"nonce\":\"5f1c9a2e\"} x\n";
  TEST_ASSERT_EQUAL_STRING("bad_json", errorCode(parseHostLine(trailing, strlen(trailing), message)));
  const char* nullAge =
      "{\"tb\":1,\"t\":\"state\",\"seq\":1,\"five\":{\"st\":\"unavailable\"},\"week\":{\"st\":\"unavailable\"},"
      "\"ctx\":{\"st\":\"current\",\"used\":5,\"age\":null},\"next\":10}\n";
  TEST_ASSERT_EQUAL_STRING("bad_field", errorCode(parseHostLine(nullAge, strlen(nullAge), message)));
}

void test_device_lines_match_the_protocol() {
  char buffer[160];
  TEST_ASSERT_GREATER_THAN(0, buildHello(buffer, sizeof(buffer), "5f1c9a2e", "0.1.0", "c3a9f01b"));
  TEST_ASSERT_EQUAL_STRING(
      "{\"tb\":1,\"t\":\"hello\",\"dev\":\"tokenbeacon-display\",\"fw\":\"0.1.0\",\"proto\":[1],\"nonce\":\"5f1c9a2e\",\"id\":\"c3a9f01b\"}\n",
      buffer);
  buildAlive(buffer, sizeof(buffer), 128, 3605);
  TEST_ASSERT_EQUAL_STRING("{\"tb\":1,\"t\":\"alive\",\"seq\":128,\"up\":3605}\n", buffer);
  buildError(buffer, sizeof(buffer), ParseError::LineTooLong);
  TEST_ASSERT_EQUAL_STRING("{\"tb\":1,\"t\":\"err\",\"code\":\"line_too_long\"}\n", buffer);
  TEST_ASSERT_EQUAL(0, buildHello(buffer, 10, "5f1c9a2e", "0.1.0", "c3a9f01b"));

  // Every valid device line in the shared vectors has this exact shape family.
  bool sawHello = false;
  for (const std::string& vector : readLines("device-to-host.jsonl")) {
    JsonDocument doc;
    deserializeJson(doc, vector);
    if (doc["expect"] == "ok" && doc["line"].as<std::string>().find("\"t\":\"hello\"") != std::string::npos) sawHello = true;
  }
  TEST_ASSERT_TRUE(sawHello);
}

void test_device_id_is_stable_hex_and_not_the_mac() {
  char a[9];
  char b[9];
  deviceIdFromMac(0x0000AABBCCDDEEFFULL, a);
  deviceIdFromMac(0x0000AABBCCDDEEFFULL, b);
  TEST_ASSERT_EQUAL_STRING(a, b);
  TEST_ASSERT_EQUAL(8, strlen(a));
  for (int i = 0; i < 8; i++) TEST_ASSERT_TRUE((a[i] >= '0' && a[i] <= '9') || (a[i] >= 'a' && a[i] <= 'f'));
  deviceIdFromMac(0x0000AABBCCDDEE00ULL, b);
  TEST_ASSERT_TRUE(strcmp(a, b) != 0);
  TEST_ASSERT_TRUE(strstr(a, "eeff") == nullptr || strstr(a, "ccdd") == nullptr);
}

// --- line buffer ----------------------------------------------------------------

void test_line_buffer() {
  LineBuffer buffer;
  const char* input = "{\"a\":1}\r\n{\"b\":2}\n";
  std::vector<std::string> lines;
  for (const char* p = input; *p; p++) {
    if (buffer.push(static_cast<uint8_t>(*p)) == LineBuffer::Event::Line) lines.push_back(std::string(buffer.line(), buffer.length()));
  }
  TEST_ASSERT_EQUAL(2, lines.size());
  TEST_ASSERT_EQUAL_STRING("{\"a\":1}\r\n", lines[0].c_str());

  // A 512-byte line (with its newline) fits; 513 bytes do not.
  std::string fits(511, 'x');
  fits += '\n';
  LineBuffer::Event last = LineBuffer::Event::None;
  for (char c : fits) last = buffer.push(static_cast<uint8_t>(c));
  TEST_ASSERT_EQUAL(LineBuffer::Event::Line, last);
  TEST_ASSERT_EQUAL(512, buffer.length());

  std::string tooLong(2000, 'y');
  tooLong += '\n';
  int tooLongEvents = 0;
  for (char c : tooLong) {
    const LineBuffer::Event event = buffer.push(static_cast<uint8_t>(c));
    TEST_ASSERT_TRUE(event != LineBuffer::Event::Line);
    if (event == LineBuffer::Event::TooLong) tooLongEvents++;
  }
  TEST_ASSERT_EQUAL(1, tooLongEvents);
  const char* after = "{\"c\":3}\n";
  for (const char* p = after; *p; p++) last = buffer.push(static_cast<uint8_t>(*p));
  TEST_ASSERT_EQUAL(LineBuffer::Event::Line, last);
  TEST_ASSERT_EQUAL_STRING("{\"c\":3}\n", buffer.line());
}

// --- display model --------------------------------------------------------------

static StateMessage sampleState(int64_t seq) {
  StateMessage s;
  s.seq = seq;
  s.five.st = ValueState::LastKnown;
  s.five.win = Window::Active;
  s.five.left = 58;
  s.five.reset = 100;
  s.five.age = 300;
  s.week.st = ValueState::LastKnown;
  s.week.win = Window::Expired;
  s.week.age = 50;
  s.ctx.st = ValueState::Current;
  s.ctx.used = 46;
  s.ctx.age = 4;
  return s;
}

void test_model_waits_for_data_and_never_invents_values() {
  DisplayModel model;
  TEST_ASSERT_EQUAL(Link::Waiting, model.link(1000));
  FieldView five = model.five(1000);
  TEST_ASSERT_EQUAL(ValueState::Unavailable, five.st);
  TEST_ASSERT_EQUAL(-1, five.percent);
  TEST_ASSERT_EQUAL(-1, model.context(1000).percent);
}

void test_model_ages_countdowns_and_link_state() {
  DisplayModel model;
  TEST_ASSERT_TRUE(model.apply(sampleState(1), 10000));
  FieldView five = model.five(10000 + 30500);
  TEST_ASSERT_EQUAL(58, five.percent);
  TEST_ASSERT_EQUAL_INT64(330, five.ageSec);
  TEST_ASSERT_EQUAL_INT64(70, five.resetSec);
  TEST_ASSERT_EQUAL_INT64(0, model.five(10000 + 500000).resetSec);
  FieldView week = model.week(10000);
  TEST_ASSERT_EQUAL(Window::Expired, week.win);
  TEST_ASSERT_EQUAL(-1, week.percent);
  TEST_ASSERT_EQUAL(Link::Live, model.link(10000 + 30000));
  TEST_ASSERT_EQUAL(Link::Stale, model.link(10000 + 30001));
  TEST_ASSERT_EQUAL(Link::Stale, model.link(10000 + 120000));
  TEST_ASSERT_EQUAL(Link::Offline, model.link(10000 + 120001));
  // Values stay visible (with growing age) when offline; nothing is estimated.
  TEST_ASSERT_EQUAL(46, model.context(10000 + 200000).percent);
  TEST_ASSERT_EQUAL_INT64(204, model.context(10000 + 200000).ageSec);
}

void test_model_sequence_order_wrap_and_reconnect() {
  DisplayModel model;
  TEST_ASSERT_TRUE(model.apply(sampleState(5), 0));
  TEST_ASSERT_FALSE(model.apply(sampleState(5), 1));  // repeated
  TEST_ASSERT_FALSE(model.apply(sampleState(4), 2));  // older
  TEST_ASSERT_TRUE(model.apply(sampleState(6), 3));
  TEST_ASSERT_FALSE(model.apply(sampleState(kMaxCount), 4));  // more than half the range back = older

  DisplayModel wrapping;
  TEST_ASSERT_TRUE(wrapping.apply(sampleState(kMaxCount - 1), 0));
  TEST_ASSERT_TRUE(wrapping.apply(sampleState(kMaxCount), 1));
  TEST_ASSERT_TRUE(wrapping.apply(sampleState(0), 2));  // wraps to 0
  TEST_ASSERT_TRUE(wrapping.apply(sampleState(1), 3));
  TEST_ASSERT_FALSE(wrapping.apply(sampleState(kMaxCount), 4));

  model.onHostHello(6);  // host restarted: its seq starts again at 0
  TEST_ASSERT_TRUE(model.apply(sampleState(0), 7));
  TEST_ASSERT_EQUAL_INT64(0, model.lastSeq());
}

void test_model_handles_millis_wraparound() {
  DisplayModel model;
  const uint32_t before = 0xFFFFFF00u;
  model.apply(sampleState(1), before);
  TEST_ASSERT_EQUAL(Link::Live, model.link(before + 5000));  // wraps past 0
  TEST_ASSERT_EQUAL_INT64(5, model.secondsSinceUpdate(before + 5000));
}

void test_now_tag_only_while_data_is_fresh() {
  // Pure rule.
  TEST_ASSERT_EQUAL(Tag::Now, valueTag(ValueState::Current, Link::Live));
  TEST_ASSERT_EQUAL(Tag::Last, valueTag(ValueState::Current, Link::Stale));
  TEST_ASSERT_EQUAL(Tag::Last, valueTag(ValueState::Current, Link::Offline));
  TEST_ASSERT_EQUAL(Tag::Last, valueTag(ValueState::LastKnown, Link::Live));
  TEST_ASSERT_EQUAL(Tag::None, valueTag(ValueState::Unavailable, Link::Live));
  TEST_ASSERT_EQUAL(Tag::None, valueTag(ValueState::Unavailable, Link::Offline));

  // Through the model: a current context value received at t=10 s.
  DisplayModel model;
  TEST_ASSERT_TRUE(model.apply(sampleState(1), 10000));
  TEST_ASSERT_EQUAL(ValueState::Current, model.context(10000).st);
  auto tagAt = [&](uint32_t nowMs) { return valueTag(model.context(nowMs).st, model.link(nowMs)); };
  TEST_ASSERT_EQUAL(Tag::Now, tagAt(10000));            // fresh
  TEST_ASSERT_EQUAL(Tag::Now, tagAt(10000 + 30000));    // exactly 30 s
  TEST_ASSERT_EQUAL(Tag::Last, tagAt(10000 + 30001));   // stale
  TEST_ASSERT_EQUAL(Tag::Last, tagAt(10000 + 720000));  // offline (12 min)
  TEST_ASSERT_TRUE(model.apply(sampleState(2), 800000));
  TEST_ASSERT_EQUAL(Tag::Now, tagAt(800000));           // a new state makes it fresh again
}

// --- formatting -------------------------------------------------------------------

void test_tx_queue_sends_long_lines_in_pieces() {
  tb::TxQueue queue;
  // A hello answer is longer than the 64-byte CDC FIFO: it goes out in pieces, intact and in order.
  std::string hello(120, 'h');
  hello.back() = '\n';
  std::string alive = "{\"tb\":1,\"t\":\"alive\",\"seq\":0,\"up\":1}\n";
  TEST_ASSERT_TRUE(queue.push(hello.data(), hello.size()));
  TEST_ASSERT_TRUE(queue.push(alive.data(), alive.size()));
  std::string sent;
  for (int round = 0; round < 10 && queue.pending() > 0; ++round) {
    const char* data = nullptr;
    const size_t n = queue.peek(64, &data);
    TEST_ASSERT_TRUE(n <= 64);
    // The host may accept fewer bytes than offered.
    const size_t accepted = round == 1 ? n / 2 : n;
    sent.append(data, accepted);
    queue.consume(accepted);
  }
  TEST_ASSERT_EQUAL_STRING((hello + alive).c_str(), sent.c_str());
  TEST_ASSERT_EQUAL_UINT32(0, queue.pending());

  // A host that stops reading: the queue fills, new lines are dropped, nothing grows.
  std::string line(100, 'x');
  size_t queued = 0;
  for (int i = 0; i < 10; ++i) queued += queue.push(line.data(), line.size()) ? 1 : 0;
  TEST_ASSERT_EQUAL_UINT32(tb::TxQueue::kCapacity / 100, queued);
  TEST_ASSERT_FALSE(queue.push(line.data(), tb::TxQueue::kCapacity + 1));
  TEST_ASSERT_FALSE(queue.push(line.data(), 0));
  // Draining makes room again; clear() drops everything (host gone).
  const char* data = nullptr;
  queue.consume(queue.peek(250, &data));
  TEST_ASSERT_TRUE(queue.push(line.data(), line.size()));
  queue.clear();
  TEST_ASSERT_EQUAL_UINT32(0, queue.pending());
}

void test_format() {
  char text[16];
  formatDuration(45, text, sizeof(text));
  TEST_ASSERT_EQUAL_STRING("45s", text);
  formatDuration(720, text, sizeof(text));
  TEST_ASSERT_EQUAL_STRING("12m", text);
  formatDuration(7920, text, sizeof(text));
  TEST_ASSERT_EQUAL_STRING("2h 12m", text);
  formatDuration(288000, text, sizeof(text));
  TEST_ASSERT_EQUAL_STRING("3d 8h", text);
  formatDuration(-1, text, sizeof(text));
  TEST_ASSERT_EQUAL_STRING("", text);
  TEST_ASSERT_EQUAL(Level::Ok, limitLevel(50));
  TEST_ASSERT_EQUAL(Level::Warn, limitLevel(49));
  TEST_ASSERT_EQUAL(Level::Warn, limitLevel(20));
  TEST_ASSERT_EQUAL(Level::Critical, limitLevel(19));
  TEST_ASSERT_EQUAL(Level::Ok, contextLevel(59));
  TEST_ASSERT_EQUAL(Level::Warn, contextLevel(60));
  TEST_ASSERT_EQUAL(Level::Critical, contextLevel(80));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_host_vectors);
  RUN_TEST(test_state_cases_parse_to_the_encoded_values);
  RUN_TEST(test_host_hello_is_read);
  RUN_TEST(test_trailing_content_and_null_fields_are_rejected);
  RUN_TEST(test_device_lines_match_the_protocol);
  RUN_TEST(test_device_id_is_stable_hex_and_not_the_mac);
  RUN_TEST(test_line_buffer);
  RUN_TEST(test_model_waits_for_data_and_never_invents_values);
  RUN_TEST(test_model_ages_countdowns_and_link_state);
  RUN_TEST(test_model_sequence_order_wrap_and_reconnect);
  RUN_TEST(test_model_handles_millis_wraparound);
  RUN_TEST(test_now_tag_only_while_data_is_fresh);
  RUN_TEST(test_tx_queue_sends_long_lines_in_pieces);
  RUN_TEST(test_format);
  return UNITY_END();
}
