import assert from "node:assert/strict";
import test from "node:test";
import { shortcutName } from "../src/review/shortcuts.mjs";

function key(name, options = {}) {
  return { name, shift: false, ...options };
}

test("shortcut names use physical base codes when terminals report them", () => {
  assert.equal(shortcutName(key("о", { baseCode: "J".codePointAt(0) })), "j");
  assert.equal(
    shortcutName(key("Х", { baseCode: "[".codePointAt(0), shift: true })),
    "{",
  );
  assert.equal(
    shortcutName(key(",", { baseCode: "/".codePointAt(0), shift: true })),
    "?",
  );
  assert.equal(
    shortcutName(key("G", { baseCode: "G".codePointAt(0), shift: true })),
    "G",
  );
});

test("shortcut names fall back to Russian QWERTY aliases", () => {
  assert.equal(shortcutName(key("о")), "j");
  assert.equal(shortcutName(key("л")), "k");
  assert.equal(shortcutName(key("с")), "c");
  assert.equal(shortcutName(key("ч")), "x");
  assert.equal(shortcutName(key("п")), "g");
  assert.equal(shortcutName(key("П", { shift: true })), "G");
  assert.equal(shortcutName(key("ы", { ctrl: true })), "s");
  assert.equal(shortcutName(key("в", { ctrl: true })), "d");
  assert.equal(shortcutName(key("г", { ctrl: true })), "u");
  assert.equal(shortcutName(key("х")), "[");
  assert.equal(shortcutName(key("Х", { shift: true })), "{");
  assert.equal(shortcutName(key("ъ")), "]");
  assert.equal(shortcutName(key("Ъ", { shift: true })), "}");
  assert.equal(shortcutName(key("down")), "down");
});
