// USD per million tokens. List prices, approximate; edit here only.
// cacheWrite = 1.25x input (5-min cache), cacheRead = 0.1x input.
const TABLE = [
  [/opus-4/, 5, 25],
  [/opus/, 4, 20],
  [/sonnet-4/, 3, 15],
  [/sonnet/, 2, 10],
  [/haiku/, 1, 5],
  [/fable|mythos/, 10, 50],
];
const DEFAULT = [3, 15];

export function rates(model = '') {
  const m = String(model).toLowerCase();
  const hit = TABLE.find(([re]) => re.test(m));
  const [input, output] = hit ? [hit[1], hit[2]] : DEFAULT;
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

export function cost(usage, model) {
  const r = rates(model);
  return (
    (usage.input_tokens || 0) * r.input +
    (usage.output_tokens || 0) * r.output +
    (usage.cache_creation_input_tokens || 0) * r.cacheWrite +
    (usage.cache_read_input_tokens || 0) * r.cacheRead
  ) / 1e6;
}
