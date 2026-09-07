/**
 * task — компонент 3 из 3.
 *
 * Связывает генератор, планировщик и три интерфейса результата: промис,
 * события и асинхронную итерацию.
 *
 * Создание таски каррировано в три уровня:
 *
 *   taskBuilder(scheduler)  // 1. какой планировщик   ─┐ настраивается
 *              (Helper)     // 2. какой хелпер        ─┘ один раз
 *              (generator)  // 3. какая функция       ─── на каждую задачу
 *
 * Без каррирования в каждый вызов пришлось бы таскать и планировщик, и хелпер.
 */

import { EventEmitter } from "./event-emitter.ts";
import type { TDataHandler, TErrorHandler } from "./event-emitter.ts";
import type { IScheduler } from "./scheduler.ts";

declare namespace ts {
  /**
   * Отрезает первый элемент кортежа — им является taskHelper, который
   * подставляется библиотекой, а не вызывающим кодом.
   *
   * Имя историческое: по смыслу это Shift/Tail, а не Pop.
   */
  type Pop<A extends any[]> = A extends [any, ...infer R] ? R : [];

  type Cast<A, B> = A extends B ? A : B;
}

/**
 * Хелпер решает, когда генератору пора уступить. Тоже стратегия: можно
 * написать свой — с приоритетами, с учётом navigator.scheduling.isInputPending(),
 * с адаптивным порогом.
 */
export interface TaskHelper {
  shouldPause(): boolean;
}

/**
 * Снаружи передаётся конструктор, а не экземпляр: каждая таска получает свой
 * хелпер со своим счётчиком времени, и создаётся он внутри task.
 */
export type TaskHelperConstructor = new (scheduler: IScheduler) => TaskHelper;

export type TaskBuilder = (
  scheduler: IScheduler,
) => <H extends TaskHelperConstructor>(
  TaskHelper: H,
) => <
  F extends (
    taskHelper: InstanceType<H>,
    ...args: any
  ) => IterableIterator<any>,
>(
  fn: F,
) => (
  ...args: ts.Pop<Parameters<F>>
  /**
   * Известный долг: слева от extends стоит `any`, а не `F`. Условный тип с
   * `any` слева разворачивается в объединение обеих веток, поэтому infer D и
   * infer R не выводятся, и типы чанков схлопываются в unknown. В демо из-за
   * этого нужны касты. Правильно было бы `F extends ...`.
   */
) => any extends (...args: any) => IterableIterator<infer D, infer R>
  ? EventablePromise<Promise<R>, D>
  : EventablePromise<Promise<unknown>>;

interface AsyncIterable<T, TReturn = any, TNext = any> {
  [Symbol.asyncIterator](): AsyncIterableIterator<T, TReturn, TNext>;
}

/**
 * Промис, на который навешены события и асинхронная итерация.
 *
 * then/catch/finally переопределены так, чтобы рекурсивно применять addEmitter
 * к производному промису. Без этого `.catch(console.error)` вернул бы обычный
 * промис и цепочка потеряла бы on() и for await.
 */
export type EventablePromise<P extends Promise<any>, D = Awaited<P>> = Omit<
  P,
  "then" | "catch" | "finally"
> & {
  on(
    event: "data",
    handler: TDataHandler<D, Awaited<P>>,
  ): EventablePromise<P, D>;
  on(event: "error", handler: TErrorHandler<any>): EventablePromise<P, D>;
  off(
    ...args: Parameters<EventEmitter<any, any>["off"]>
  ): EventablePromise<P, D>;
  then<T1 = Awaited<P>, T2 = never>(
    onfulfilled?:
      | ((value: Awaited<P>) => T1 | PromiseLike<T1>)
      | undefined
      | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | undefined | null,
  ): EventablePromise<Promise<T1 | T2>, D>;
  catch<T = never>(
    onrejected?: ((reason: any) => T | PromiseLike<T>) | undefined | null,
  ): EventablePromise<Promise<Awaited<P> | T>, D>;
  finally(onfinally?: (() => void) | undefined | null): EventablePromise<P, D>;
} & AsyncIterable<D, Awaited<P>>;

/**
 * Простейший хелпер: паузится по времени.
 *
 * Порог — quota / 4, то есть за один такт планировщик успевает прокрутить
 * примерно четыре шага. Это могут быть четыре шага одной задачи или по одному
 * шагу четырёх задач — суммарный блок в обоих случаях ограничен quota.
 *
 * Коэффициент 4 — компромисс: больше значит точнее держится бюджет, но чаще
 * дёргается performance.now().
 *
 * Считать надо именно время, а не количество итераций: на прогретом JIT одна
 * итерация выполняется в разы быстрее, чем на холодном, и порог «каждые N
 * элементов» давал бы совершенно разную длину блока.
 */
export class SimpleTaskHelper implements TaskHelper {
  protected time = 0;

  protected scheduler: IScheduler;

  constructor(scheduler: IScheduler) {
    this.scheduler = scheduler;
  }

  shouldPause() {
    this.time ||= performance.now();

    if (performance.now() - this.time > this.scheduler.quota / 4) {
      this.time = 0;
      return true;
    }

    return false;
  }
}

export const taskBuilder: TaskBuilder =
  (scheduler) =>
  (TaskHelper) =>
  (job) =>
  (...args) => {
    const emitter = new EventEmitter();

    const taskHelper = new TaskHelper(scheduler) as InstanceType<
      typeof TaskHelper
    >;

    // Колбэк — мост между планировщиком и тремя интерфейсами результата.
    const promise = new Promise<unknown>((resolve, reject) => {
      scheduler.push(job(taskHelper, ...args), (result) => {
        if ("error" in result) {
          emitter.emit("error", result);
          // Наружу отдаём саму ошибку, а не объект {done, error, value}:
          // у обёртки нет стека и не работает instanceof.
          reject(result.error);
        } else {
          emitter.emit("data", result);

          if (result.done) {
            resolve(result.value);
          }
        }
      });
    });

    // Если пользователь ловит ошибки только через on("error") и не вешает
    // .catch(), промис остался бы с необработанным реджектом — а это в
    // Node 15+ по умолчанию падение процесса.
    //
    // Плата: не повесив ни .catch, ни on("error"), ошибку можно потерять молча.
    void promise.catch(() => {});

    return addEmitter(promise);

    function addEmitter(
      target: Promise<unknown>,
    ): EventablePromise<Promise<any>> {
      const eventablePromise = target as EventablePromise<Promise<any>>;

      // Оригиналы берём с прототипа, а не с самого объекта, — иначе поймаем
      // уже переопределённую версию.
      for (const key of ["then", "catch", "finally"] as const) {
        const original = Promise.prototype[key] as Function;

        void Object.defineProperty(eventablePromise, key, {
          configurable: true,
          writable: true,
          value: (...callArgs: unknown[]) =>
            addEmitter(original.apply(target, callArgs) as Promise<unknown>),
        });
      }

      void Object.defineProperty(eventablePromise, "on", {
        configurable: true,
        writable: true,
        value: (...onArgs: Parameters<EventEmitter["on"]>) => {
          emitter.on(...onArgs);
          return eventablePromise; // для чейнинга
        },
      });

      void Object.defineProperty(eventablePromise, "off", {
        configurable: true,
        writable: true,
        value: (...offArgs: Parameters<EventEmitter["off"]>) => {
          emitter.off(...offArgs);
          return eventablePromise;
        },
      });

      void Object.defineProperty(eventablePromise, Symbol.asyncIterator, {
        configurable: true,
        writable: true,
        value: () => emitter[Symbol.asyncIterator](),
      });

      return eventablePromise;
    }
  };
