/**
 * РЕШЕНИЕ. Та же работа, но задача разбита на короткие шаги.
 *
 *   node demo-cooperative.ts
 *
 * Сравнивать с demo-problem.ts по одному числу: максимальный интервал между
 * тиками heartbeat. Там он был порядка длительности всего счёта, здесь должен
 * укладываться в 10–20 мс.
 *
 * Заодно демо показывает все три интерфейса результата на одном объекте:
 * on("data"), for await и await.
 */

import { RoundRobinScheduler } from "../scheduler.ts";
import { SimpleTaskHelper, taskBuilder } from "../task.ts";

/**
 * quota — максимальная задержка, навязанная потоку. Крутить ради отзывчивости.
 * delay — доля CPU, которую отдаём наружу. Крутить ради скорости счёта.
 *
 * 8 / 4 → блок ≈ 10 мс (влезает в кадр 16.6 мс), задаче достаётся ~67% CPU.
 * Попробуй поставить 300 / 50 и посмотри, как heartbeat замолчит совсем.
 */
const scheduler = new RoundRobinScheduler({ quota: 8, delay: 4 });

const task = taskBuilder(scheduler)(SimpleTaskHelper);

const exec = task(function* doSomething(t, n: number) {
  let data: number[] = [];

  for (let i = 0; i < n; i++) {
    data.push(i);

    // Генератор говорит «здесь меня можно прервать».
    // Решение прервать по-настоящему принимает планировщик.
    if (t.shouldPause()) {
      yield data;
      data = [];
    }
  }

  if (data.length > 0) {
    yield data;
  }

  return "done";
});

let last = performance.now();

const heartbeat = setInterval(() => {
  const now = performance.now();
  console.log(`heartbeat +${(now - last).toFixed(0)}ms`);
  last = now;
}, 10);

void (async () => {
  const started = performance.now();
  const run = exec(2_000_000);

  // Интерфейс 1: события. Срабатывают синхронно, внутри занятого блока.
  run.on("data", (result) => {
    if (!result.done) {
      // каст нужен из-за известного долга в типах TaskBuilder
      console.log("on(data):  ", (result.value as number[]).length);
    }
  });

  try {
    // Интерфейс 2: асинхронная итерация. Просыпается на микрозадачах, то есть
    // уже после конца синхронного блока. Поэтому в выводе сначала идёт пачка
    // on(data), и только потом та же пачка for await — это нормально.
    for await (const chunk of run) {
      console.log("for await: ", (chunk as number[]).length);
    }

    // Интерфейс 3: промис с финальным значением.
    console.log("result:", await run);
    console.log(`посчитали за ${(performance.now() - started).toFixed(0)}ms`);
  } catch (error) {
    console.log("error:", error);
  } finally {
    clearInterval(heartbeat);
  }
})();
