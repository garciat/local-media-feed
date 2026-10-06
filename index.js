/**
 * @param {FileSystemDirectoryHandle} directoryHandle
 * @returns {AsyncIterable<FileSystemFileHandle>}
 */
async function* findAllFiles(directoryHandle) {
  // assert(directoryHandle.kind === "directory");

  for await (const handle of directoryHandle.values()) {
    switch (handle.kind) {
      case "file":
        yield handle;
        break;
      case "directory":
        yield* findAllFiles(handle);
        break;
      default:
        throw new TypeError("unexpected type");
    }
  }
}

/**
 * @template T
 * @param {AsyncIterable<T>} iter
 * @returns {Promise<T[]>}
 */
function arrayFromAsync(iter) {
  return Array.fromAsync(iter);
}

/**
 * @template T
 * @param {T[]} array
 * @returns {T[]}
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

let toastTimeout;

function toast(message, duration = 3000) {
  clearTimeout(toastTimeout);

  const element = document.getElementById("toast");
  element.textContent = message;
  element.showPopover();

  toastTimeout = setTimeout(() => {
    element.hidePopover();
  }, duration);
}

document
  .getElementById("toggle-fullscreen")
  .addEventListener("click", async () => {
    menu.hidePopover();

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  });

/** @type {Feed} */
let feed;

document
  .getElementById("open-folder")
  .addEventListener("click", async () => {
    menu.hidePopover();

    if (typeof window.showDirectoryPicker !== "function") {
      alert("Your browser does not support showDirectoryPicker()");
      return;
    }

    const directory = await window.showDirectoryPicker({
      id: "local-media-feed",
      mode: "read",
      startIn: "videos",
    });

    const t = performance.now();

    const fileHandles = await arrayFromAsync(findAllFiles(directory));

    const videoHandles = fileHandles
      .filter((fh) => /\.(mp4|webm|mkv|mov|avi)$/i.test(fh.name));

    toast(
      `Loaded ${videoHandles.length} files in ${
        (performance.now() - t).toFixed(0)
      }ms`,
    );

    feed?.dispose();

    feed = new Feed({
      domList: document.querySelector(".list"),
      handles: shuffle(videoHandles),
      listenerProgress: (progress) => {
        const element = document.querySelector(".progress > .fill");
        element.style.width = `${100 * progress}%`;
      },
    });
  });

window
  .visualViewport
  .addEventListener("resize", () => {
    feed?.handleResize();
  });

class Feed {
  /** @type {Element} */
  #domList;
  /** @type {FileSystemFileHandle[]} */
  #handles;
  /** @type {IntersectionObserver} */
  #observer;
  /** @type {(progress: number) => {}} */
  #listenerProgress;

  /** @type {Element[]} */
  #domItems;

  #playing = true;
  #current = 0;

  static #countKeepBack = 2;
  static #countKeepFront = 2;

  /**
   * @param {number} center
   */
  *#getRange(center) {
    const a = Math.max(0, center - Feed.#countKeepBack);
    const b = Math.min(
      this.#domItems.length,
      1 + center + Feed.#countKeepFront,
    );

    for (let i = a; i < b; i++) {
      yield i;
    }
  }

  /**
   * @param {number} index
   * @returns {HTMLVideoElement | null}
   */
  #mediaAt(index) {
    return this.#domItems[index]?.querySelector("video");
  }

  /**
   * @param {number} target
   */
  async #onActivateItemIndex(target) {
    // console.log(`onActivateItemIndex(${target})`);

    const prev = new Set(
      Array.from(this.#getRange(this.#current))
        .map((i) => this.#domItems[i])
        .filter((item) => Boolean(item.querySelector("video"))),
    );

    const next = new Set(
      Array.from(this.#getRange(target))
        .map((i) => this.#domItems[i]),
    );

    /** @type {Set<Element>} */
    const drop = prev.difference(next);
    /** @type {Set<Element>} */
    const hydrate = next.difference(prev);

    for (const item of drop) {
      const video = item.querySelector("video");
      URL.revokeObjectURL(video.src);
      video.remove();
    }

    for (const item of hydrate) {
      const index = this.#domItems.indexOf(item);

      const file = await this.#handles[index].getFile();

      const video = document.createElement("video");
      video.src = URL.createObjectURL(file);
      video.loop = true;

      const update = () => {
        this.#listenerProgress?.(video.currentTime / video.duration);
        if (!video.paused) {
          video.requestVideoFrameCallback(update);
        }
      };

      video.addEventListener("play", () => {
        update();
      });

      item.appendChild(video);
    }

    {
      this.#listenerProgress?.(
        this.#mediaAt(target)?.currentTime / this.#mediaAt(target)?.duration,
      );
    }

    if (this.#playing) {
      this.#mediaAt(this.#current)?.pause();

      this.#mediaAt(target)?.play();
    }

    this.#current = target;
  }

  /**
   * @param {IntersectionObserverEntry[]} entries
   */
  #onIntersectionObserved(entries) {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const intersectingIndex = this.#domItems.indexOf(entry.target);
        this.#onActivateItemIndex(intersectingIndex);
      }
    });
  }

  #onListClick() {
    if (this.#playing) {
      this.#mediaAt(this.#current)?.pause();
      this.#playing = false;
    } else {
      this.#mediaAt(this.#current)?.play();
      this.#playing = true;
    }
  }

  handleResize() {
    const item = this.#domItems[this.#current];

    item?.scrollIntoView({
      block: "start",
      behavior: "instant",
    });
  }

  dispose() {
    this.#observer.disconnect();
    this.#domList.replaceChildren();
  }

  #createItemDOM() {
    const item = document.createElement("li");
    item.classList.add("item");
    return item;
  }

  #initialize() {
    this.#domItems = this.#handles.map(() => this.#createItemDOM());

    this.#domList.replaceChildren(...this.#domItems);

    this.#observer = new IntersectionObserver((entries) => {
      this.#onIntersectionObserved(entries);
    }, {
      root: this.#domList,
      threshold: 0.6,
    });

    for (const child of this.#domItems) {
      this.#observer.observe(child);
    }

    this.#domList.addEventListener("click", () => {
      this.#onListClick();
    });
  }

  /**
   * @param {{
   *  domList: Element,
   *  handles: FileSystemFileHandle[],
   *  listenerProgress: (progress: number) => {}
   * }}
   */
  constructor({ domList, handles, listenerProgress }) {
    this.#domList = domList;
    this.#handles = handles;
    this.#listenerProgress = listenerProgress;

    this.#initialize();
  }
}
