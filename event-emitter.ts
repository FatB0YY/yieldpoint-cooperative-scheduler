/**
 * EventEmitter — компонент 1 из 3.
 *
 * Раздаёт два события, `data` и `error`, и умеет работать как асинхронный
 * итератор. Оба интерфейса живут одновременно на одном объекте: можно и
 * подписаться через on("data"), и писать `for await ... of`.
 *
 * Ключевая деталь реализации — буфер. Планировщик за один синхронный такт
 * успевает сделать несколько шагов задачи и несколько раз вызвать emit(),
 * а потребитель асинхронного итератора просыпается только на микрозадаче,
 * то есть после конца всего блока. Без буфера все чанки, кроме первого,
 * терялись бы.
 */

export type TEvent = "data" | "error";

/** Результат шага задачи в формате протокола итератора. */
export type TDataResult<D = unknown, R = unknown> =
  | { done: false; value: D } // промежуточный чанк
  | { done: true; value: R }; // финальное значение

export type TErrorResult<E = unknown> = {
  done: true;
  error: E;
  value: undefined;
};

export type TDataHandler<D, R> = (data: TDataResult<D, R>) => void;
export type TErrorHandler<E> = (err: TErrorResult<E>) => void;

/** Элемент внутреннего буфера асинхронной итерации. */
type TBufferItem<D, R, E> =
  | { type: "data"; payload: TDataResult<D, R> }
  | { type: "error"; payload: TErrorResult<E> };

export class EventEmitter<D = unknown, R = unknown, E = unknown> {
  /**
   * Заранее объявленный объект с двумя фиксированными полями, а не Map с
   * произвольными ключами: движок построит стабильный hidden class, доступ
   * к полям будет мономорфным.
   */
  #handlers = {
    data: new Set<TDataHandler<D, R>>(),
    error: new Set<TErrorHandler<E>>(),
  };

  /**
   * Известный долг: поле читается в next(), но нигде не выставляется в true.
   * На нормальном пути не стреляет — for await завершается по {done: true}
   * из буфера и больше не зовёт next(). Но явный next() после завершения
   * задачи повиснет навсегда.
   */
  #done = false;

  /** Непрочитанное. Растёт, если потребитель медленнее производителя. */
  readonly #buffer: TBufferItem<D, R, E>[] = [];

  /**
   * Очередь ожидающих next(). Именно очередь, а не одно поле: иначе два
   * параллельных next() получили бы один и тот же промис, то есть одно и то
   * же значение — прямое нарушение контракта асинхронного итератора.
   */
  readonly #pending: PromiseWithResolvers<TDataResult<D, R>>[] = [];

  /**
   * Буферизация ленивая — включается на первом обращении к итератору.
   * Если буферизовать с самого создания, то у того, кто пользуется только
   * on("data") и никогда не итерируется, буфер рос бы на всю задачу.
   */
  #buffering = false;

  [Symbol.asyncIterator]() {
    this.#buffering = true;

    return {
      [Symbol.asyncIterator]() {
        return this;
      },

      next: (): Promise<TDataResult<D, R>> => {
        const buffered = this.#buffer.shift();

        if (buffered != null) {
          return buffered.type === "data"
            ? Promise.resolve(buffered.payload)
            : Promise.reject(buffered.payload.error);
        }

        if (this.#done) {
          return Promise.resolve({
            done: true,
            value: undefined as unknown as R,
          });
        }

        const waiter = Promise.withResolvers<TDataResult<D, R>>();
        this.#pending.push(waiter);

        return waiter.promise;
      },
    };
  }

  on(event: "data", handler: TDataHandler<D, R>): void;
  on(event: "error", handler: TErrorHandler<E>): void;
  on(event: TEvent, handler: TDataHandler<D, R> | TErrorHandler<E>) {
    this.#getStore(event).add(handler);
  }

  /**
   * off() умеет всё сразу:
   *   off()                  — снять вообще все обработчики
   *   off("data")            — снять все обработчики события
   *   off("data", handler)   — снять один обработчик
   */
  off(event?: TEvent, handler?: Function) {
    if (event == null) {
      this.off("data", handler);
      this.off("error", handler);
      return;
    }

    const store = this.#getStore(event);

    if (handler == null) {
      store.clear();
    } else {
      store.delete(handler);
    }
  }

  emit(event: "data", data: TDataResult<D, R>): void;
  emit(event: "error", error: TErrorResult<E>): void;
  emit(event: TEvent, payload: TDataResult<D, R> | TErrorResult<E>) {
    // Внутренний сток итератора вызывается явно, а не через this.on(...):
    // пользовательский off() без аргументов делает store.clear() и снёс бы
    // внутреннюю подписку вместе с чужими.
    if (event === "data") {
      this.#feed({ type: "data", payload: payload as TDataResult<D, R> });
    } else {
      this.#feed({ type: "error", payload: payload as TErrorResult<E> });
    }

    this.#getStore(event).forEach((handler) => {
      handler(payload);
    });
  }

  /** Кто-то ждёт — отдаём ему. Никто не ждёт — кладём в буфер. */
  #feed(item: TBufferItem<D, R, E>) {
    if (!this.#buffering) {
      return;
    }

    const waiter = this.#pending.shift();

    if (waiter == null) {
      this.#buffer.push(item);
      return;
    }

    if (item.type === "data") {
      waiter.resolve(item.payload);
    } else {
      // Реджектим самой ошибкой, а не объектом-обёрткой: так сохраняется
      // стек и работает instanceof.
      waiter.reject(item.payload.error);
    }
  }

  #getStore(event: TEvent): Set<Function> {
    return event === "data" ? this.#handlers.data : this.#handlers.error;
  }
}
