/**
 * ПРОБЛЕМА. Библиотека здесь не используется вообще.
 *
 *   node demo-problem.ts
 *
 * Обычная синхронная функция занимает поток целиком. Пока она считает,
 * движок не может ничего: ни отрисовать кадр, ни принять соединение, ни
 * запустить колбэк таймера.
 *
 * Индикатор — heartbeat на 10 мс. Он печатает не факт тика, а реальный
 * интервал между тиками: так видно не «сработал / не сработал», а насколько
 * поток был занят.
 *
 * Ожидаемый вывод: несколько ровных «+10ms» в начале, потом тишина на всё
 * время счёта, потом один огромный интервал.
 */

function bigArray(n: number) {
  const array: number[] = [];

  for (let i = 0; i < n; i++) {
    array.push(i);
  }

  return array;
}

let last = performance.now();

const heartbeat = setInterval(() => {
  const now = performance.now();
  console.log(`heartbeat +${(now - last).toFixed(0)}ms`);
  last = now;
}, 10);

// даём таймеру тикнуть пару раз, чтобы было с чем сравнивать
setTimeout(() => {
  console.log("--- начали считать ---");

  const started = performance.now();

  for (let i = 0; i < 20; i++) {
    console.log("chunk:", bigArray(1_000_000).length);
  }

  console.log(`--- посчитали за ${(performance.now() - started).toFixed(0)}ms ---`);

  clearInterval(heartbeat);
}, 50);
