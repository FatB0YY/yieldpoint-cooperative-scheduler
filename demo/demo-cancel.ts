/**
 * ОТМЕНА.
 *
 *   node demo-cancel.ts
 *
 * scheduler.clear() должен сделать четыре вещи, и все четыре здесь проверяются:
 *
 *   1. снять отложенный setTimeout, иначе после следующего push() на одной
 *      очереди поедут два цикла сразу;
 *   2. закрыть генераторы через job.return() — тогда внутри отработают
 *      finally-блоки и ресурсы освободятся;
 *   3. зареджектить промисы отменённых задач, иначе они повиснут навсегда;
 *   4. отдать ошибку в оба интерфейса: и в on("error"), и в промис.
 *
 * Признак успеха: в консоли есть строка из finally, ошибка приехала со стеком,
 * и процесс завершился сам, без зависания.
 */

import { RoundRobinScheduler, TaskCancelledError } from "../scheduler.ts";
import { SimpleTaskHelper, taskBuilder } from "../task.ts";

const scheduler = new RoundRobinScheduler({ quota: 8, delay: 4 });

const task = taskBuilder(scheduler)(SimpleTaskHelper);

const exec = task(function* neverEnding(t, n: number) {
  console.log("задача: старт, ресурс захвачен");

  try {
    let data: number[] = [];

    for (let i = 0; i < n; i++) {
      data.push(i);

      if (t.shouldPause()) {
        yield data;
        data = [];
      }
    }

    return "done";
  } finally {
    // Сработает и при обычном завершении, и при job.return() из clear().
    // Без вызова return() этот блок не отработал бы и ресурс утёк.
    console.log("задача: finally, ресурс освобождён");
  }
});

const run = exec(200_000_000);

let chunks = 0;

run.on("data", (result) => {
  if (!result.done) {
    chunks++;
  }
});

run.on("error", (err) => {
  console.log("on(error):", (err.error as Error).name);
});

void (async () => {
  try {
    await run;
    console.log("сюда мы попасть не должны");
  } catch (error) {
    console.log("catch:", error instanceof TaskCancelledError, String(error));
    console.log(`успели насчитать чанков: ${chunks}`);
  }
})();

// Даём поработать 300 мс и отменяем.
setTimeout(() => {
  console.log("--- clear() ---");
  scheduler.clear();
}, 300);
