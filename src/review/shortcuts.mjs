const SHIFTED_BASE_KEYS = Object.freeze({
  "[": "{",
  "]": "}",
  "/": "?",
});

const RUSSIAN_QWERTY = Object.freeze({
  й: "q",
  ц: "w",
  у: "e",
  к: "r",
  е: "t",
  н: "y",
  г: "u",
  ш: "i",
  щ: "o",
  з: "p",
  х: "[",
  ъ: "]",
  ф: "a",
  ы: "s",
  в: "d",
  а: "f",
  п: "g",
  р: "h",
  о: "j",
  л: "k",
  д: "l",
  ж: ";",
  э: "'",
  я: "z",
  ч: "x",
  с: "c",
  м: "v",
  и: "b",
  т: "n",
  ь: "m",
  б: ",",
  ю: ".",
});

function shiftedShortcut(name, shift) {
  if (shift && name === "g") return "G";
  return shift ? (SHIFTED_BASE_KEYS[name] ?? name) : name;
}

export function shortcutName(key) {
  if (Number.isInteger(key.baseCode)) {
    const base = String.fromCodePoint(key.baseCode);
    if (/^[A-Z]$/u.test(base)) {
      return shiftedShortcut(base.toLowerCase(), key.shift);
    }
    if (/^[a-z]$/u.test(base)) return shiftedShortcut(base, key.shift);
    return shiftedShortcut(base, key.shift);
  }

  const name = String(key.name ?? "");
  if ([...name].length !== 1) return name;
  const lower = name.toLocaleLowerCase("ru-RU");
  if (/^[a-z]$/u.test(lower)) {
    return shiftedShortcut(lower, key.shift || name !== lower);
  }
  const physical = RUSSIAN_QWERTY[lower];
  if (!physical) return name;
  const shifted = key.shift || name !== lower;
  return shiftedShortcut(physical, shifted);
}
