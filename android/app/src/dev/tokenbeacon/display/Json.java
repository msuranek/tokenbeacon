package dev.tokenbeacon.display;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small strict JSON reader (RFC 8259) with the same results as JSON.parse
 * for the values the protocol uses: objects become Map, arrays List, numbers
 * Double, plus String, Boolean and null (JSON_NULL). Plain Java, so the
 * protocol code also runs in JVM tests. Duplicate keys: the last one wins.
 */
final class Json {
    static final Object JSON_NULL = new Object();
    private static final int MAX_DEPTH = 16;

    private final String text;
    private int pos;

    private Json(String text) {
        this.text = text;
    }

    static final class ParseException extends Exception {
        ParseException() {
            super("bad_json");
        }
    }

    static Object parse(String text) throws ParseException {
        Json reader = new Json(text);
        reader.skipSpace();
        Object value = reader.readValue(0);
        reader.skipSpace();
        if (reader.pos != text.length()) throw new ParseException();
        return value;
    }

    private Object readValue(int depth) throws ParseException {
        if (depth > MAX_DEPTH || pos >= text.length()) throw new ParseException();
        char c = text.charAt(pos);
        switch (c) {
            case '{': return readObject(depth);
            case '[': return readArray(depth);
            case '"': return readString();
            case 't': return literal("true", Boolean.TRUE);
            case 'f': return literal("false", Boolean.FALSE);
            case 'n': return literal("null", JSON_NULL);
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return readNumber();
                throw new ParseException();
        }
    }

    private Map<String, Object> readObject(int depth) throws ParseException {
        Map<String, Object> map = new LinkedHashMap<>();
        pos++;
        skipSpace();
        if (peek() == '}') {
            pos++;
            return map;
        }
        while (true) {
            skipSpace();
            if (peek() != '"') throw new ParseException();
            String key = readString();
            skipSpace();
            expect(':');
            skipSpace();
            map.put(key, readValue(depth + 1));
            skipSpace();
            char c = next();
            if (c == '}') return map;
            if (c != ',') throw new ParseException();
        }
    }

    private List<Object> readArray(int depth) throws ParseException {
        List<Object> list = new ArrayList<>();
        pos++;
        skipSpace();
        if (peek() == ']') {
            pos++;
            return list;
        }
        while (true) {
            skipSpace();
            list.add(readValue(depth + 1));
            skipSpace();
            char c = next();
            if (c == ']') return list;
            if (c != ',') throw new ParseException();
        }
    }

    private String readString() throws ParseException {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            char c = next();
            if (c == '"') return out.toString();
            if (c < 0x20) throw new ParseException();
            if (c != '\\') {
                out.append(c);
                continue;
            }
            char e = next();
            switch (e) {
                case '"': out.append('"'); break;
                case '\\': out.append('\\'); break;
                case '/': out.append('/'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u': {
                    if (pos + 4 > text.length()) throw new ParseException();
                    try {
                        out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                    } catch (NumberFormatException ex) {
                        throw new ParseException();
                    }
                    pos += 4;
                    break;
                }
                default: throw new ParseException();
            }
        }
    }

    private Double readNumber() throws ParseException {
        int start = pos;
        if (peek() == '-') pos++;
        if (peek() == '0') {
            pos++;
        } else if (isDigit(peek())) {
            while (isDigit(peek())) pos++;
        } else {
            throw new ParseException();
        }
        if (peek() == '.') {
            pos++;
            if (!isDigit(peek())) throw new ParseException();
            while (isDigit(peek())) pos++;
        }
        if (peek() == 'e' || peek() == 'E') {
            pos++;
            if (peek() == '+' || peek() == '-') pos++;
            if (!isDigit(peek())) throw new ParseException();
            while (isDigit(peek())) pos++;
        }
        return Double.parseDouble(text.substring(start, pos));
    }

    private Object literal(String word, Object value) throws ParseException {
        if (!text.startsWith(word, pos)) throw new ParseException();
        pos += word.length();
        return value;
    }

    private void skipSpace() {
        while (pos < text.length()) {
            char c = text.charAt(pos);
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
            pos++;
        }
    }

    private char peek() {
        return pos < text.length() ? text.charAt(pos) : '\0';
    }

    private char next() throws ParseException {
        if (pos >= text.length()) throw new ParseException();
        return text.charAt(pos++);
    }

    private void expect(char c) throws ParseException {
        if (next() != c) throw new ParseException();
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }
}
