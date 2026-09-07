/**
 * ДВЕ ЗАДАЧИ ПО КРУГУ.
 *
 *   node demo-parallel.ts
 *
 * Главное требование к планировщику: quota — это бюджет НА ВСЕ задачи вместе,
 * а не на каждую. Иначе с ростом числа тасок поток снова встанет.
 *
 * В выводе видно чередование A / B — это round robin: каждая задача получает
 * один шаг и уезжает в конец очереди. Задачи разного размера, поэтому короткая
 * закончится раньше, и вторая половина вывода будет только из B.
 *
 * Попробуй запустить три-четыре задачи: интервалы heartbeat не вырастут,
 * вырастет только общее время счёта.
 */

import { RoundRobinScheduler } from "../scheduler.ts";
import { SimpleTaskHelper, taskBuilder } from "../task.ts";

const scheduler = new RoundRobinScheduler({ quota: 8, delay: 4 });

const task = taskBuilder(scheduler)(SimpleTaskHelper);

const count = task(function* count(t, label: string, n: number) {
  let processed = 0;
  let total = 0;

  for (let i = 0; i < n; i++) {
    processed++;
    total++;

    if (t.shouldPause()) {
      yield { label, processed };
      processed = 0;
    }
  }

  return `${label}: ${total}`;
});

const startedAt = performance.now();

const at = () => `${(performance.now() - startedAt).toFixed(0).padStart(4)}ms`;

let last = performance.now();

const heartbeat = setInterval(() => {
  const now = performance.now();
  console.log(`${at()}  heartbeat +${(now - last).toFixed(0)}ms`);
  last = now;
}, 10);

const a = count("A", 1_500_000);
const b = count("B", 4_000_000);

for (const run of [a, b]) {
  run.on("data", (result) => {
    if (!result.done) {
      const chunk = result.value as { label: string; processed: number };
      console.log(`${at()}  ${chunk.label} +${chunk.processed}`);
    }
  });
}

void (async () => {
  // Обе задачи считаются одновременно, планировщик делит между ними такт.
  const results = await Promise.all([a, b]);

  console.log("результаты:", results);
  console.log(`всего: ${(performance.now() - startedAt).toFixed(0)}ms`);

  clearInterval(heartbeat);
})();
