/**
 * Публичный API библиотеки.
 *
 * Файл ничего не выполняет — это только реэкспорт. Запускать надо демо:
 *
 *   node demo-problem.ts       — как выглядит проблема
 *   node demo-cooperative.ts   — как её решает кооперативность
 *   node demo-parallel.ts      — две задачи по кругу
 *   node demo-cancel.ts        — отмена через scheduler.clear()
 *   node demo-error.ts         — ошибка внутри генератора
 */

export * from "./event-emitter.ts";
export * from "./scheduler.ts";
export * from "./task.ts";
