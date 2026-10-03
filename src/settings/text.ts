const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Named keys are commands, never field text. Accept one printable grapheme (including emoji). */
export function isTextInput(key: string): boolean {
  return key === "Backspace" || key === "Space" || (!/[\x00-\x1f\x7f-\x9f]/.test(key) && [...graphemes.segment(key)].length === 1);
}

export function editText(value: string, key: string): string {
  return key === "Backspace" ? [...graphemes.segment(value)].slice(0, -1).map((part) => part.segment).join("")
    : value + (key === "Space" ? " " : key);
}
