/**
 * ОШИБКА ВНУТРИ ГЕНЕРАТОРА.
 *
 *   node demo-error.ts
 *
 * Исключение из job.next() ловится в планировщике и превращается в результат
 * с полем error. Дальше task разводит его по обоим интерфейсам: в on("error")
 * едет объект целиком, в промис — сама ошибка.
 *
 * Почему в промис именно `result.error`, а не весь объект: у обёртки
 * {done, error, value} нет стека и не работает instanceof — отлаживать
 * невозможно.
 *
 * Вторая проверка здесь — про unhandled rejection. Вторая таска ловит ошибку
 * ТОЛЬКО через on("error") и не вешает .catch(). Без внутреннего
 * `void promise.catch(() => {})` в task.ts Node уронил бы процесс.
 */

import { RoundRobinScheduler } from "../scheduler.ts";
import { SimpleTaskHelper, taskBuilder } from "../task.ts";

const scheduler = new RoundRobinScheduler({ quota: 8, delay: 4 });

const task = taskBuilder(scheduler)(SimpleTaskHelper);

const exec = task(function* failing(t, failAt: number) {
  let data: number[] = [];

  for (let i = 0; i < 10_000_000; i++) {
    if (i === failAt) {
      throw new RangeError(`сломались на ${i}`);
    }

    data.push(i);

    if (t.shouldPause()) {
      yield data;
      data = [];
    }
  }

  return "done";
});

// --- случай 1: ошибку ловят через promise --------------------------------

void (async () => {
  try {
    for await (const chunk of exec(3_000_000)) {
      console.log("1) чанк:", (chunk as number[]).length);
    }
  } catch (error) {
    console.log("1) catch:", error instanceof RangeError, String(error));
    console.log("1) стек на месте:", (error as Error).stack != null);
  }
})();

// --- случай 2: ошибку ловят ТОЛЬКО через on("error") ----------------------
// .catch() намеренно не вешается — процесс не должен упасть.

exec(1_000_000).on("error", (err) => {
  console.log("2) on(error):", String(err.error));
  console.log("2) done:", err.done, "value:", err.value);
});

process.on("exit", (code) => {
  console.log(`процесс завершился нормально, код ${code}`);
});
