// @ts-check
/// <reference lib="esnext" />
/// <reference types="./showDirectoryPicker.d.ts" />

"use strict";

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

/**
 * @param {string} id
 */
function getElementByIdStrict(id) {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`expected element with id: ${id}`);
  return elem;
}

/** @type {number | undefined} */
let toastTimeout;

/**
 * @param {string} message
 * @param {number} duration
 */
function toast(message, duration = 3000) {
  clearTimeout(toastTimeout);

  const element = getElementByIdStrict("toast");
  element.textContent = message;
  element.showPopover();

  toastTimeout = setTimeout(() => {
    element.hidePopover();
  }, duration);
}

getElementByIdStrict("toggle-fullscreen")
  .addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  });

/** @type {Feed | undefined} */
let feed;

getElementByIdStrict("open-folder")
  .addEventListener("click", async () => {
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
      domList: getElementByIdStrict("media-list"),
      handles: shuffle(videoHandles),
      listenerProgress: (progress) => {
        /** @type {HTMLElement | null} */
        const element = document.querySelector(".progress > .fill");
        if (element) {
          element.style.width = `${100 * progress}%`;
        }
      },
    });
  });

window
  .visualViewport
  ?.addEventListener("resize", () => {
    feed?.handleResize();
  });

class Feed {
  /** @type {Element} */
  #domList;
  /** @type {FileSystemFileHandle[]} */
  #handles;
  /** @type {IntersectionObserver} */
  #observer;
  /** @type {(progress: number) => void} */
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
   */
  #mediaKindOf(index) {
    const fh = this.#handles[index];
    if (/\.(mp4|webm|mkv|mov|avi)$/i.test(fh.name)) {
      return /** @type {const} */ ("video");
    } else {
      throw new Error(`unexpected media type: ${fh}`);
    }
  }

  /**
   * @param {number} index
   */
  async #mountMedia(index) {
    switch (this.#mediaKindOf(index)) {
      case "video":
        {
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

          const item = this.#domItems[index];
          item.appendChild(video);
        }
        break;
    }
  }

  /**
   * @param {number} index
   */
  #unmountMedia(index) {
    switch (this.#mediaKindOf(index)) {
      case "video":
        {
          const video = this.#domItems[index].querySelector("video");
          if (video) {
            URL.revokeObjectURL(video.src);
            video.remove();
          }
        }
        break;
    }
  }

  /**
   * @param {number} index
   */
  #mediaAt(index) {
    switch (this.#mediaKindOf(index)) {
      case "video":
        return this.#domItems[index]?.querySelector("video");
    }
  }

  /**
   * @param {number} index
   */
  #getMediaProgress(index) {
    switch (this.#mediaKindOf(index)) {
      case "video": {
        const video = this.#domItems[index]?.querySelector("video");
        if (video) {
          return video.currentTime / video.duration;
        } else {
          return 0;
        }
      }
    }
  }

  /**
   * @param {number} index
   */
  #pauseMedia(index) {
    switch (this.#mediaKindOf(index)) {
      case "video": {
        const video = this.#domItems[index]?.querySelector("video");
        return video?.pause();
      }
    }
  }

  /**
   * @param {number} index
   */
  #resumeMedia(index) {
    switch (this.#mediaKindOf(index)) {
      case "video": {
        const video = this.#domItems[index]?.querySelector("video");
        return video?.play();
      }
    }
  }

  /**
   * @param {number} index
   */
  #hasMountedMedia(index) {
    return Boolean(this.#mediaAt(index));
  }

  /**
   * @param {number} target
   */
  async #onActivateItemIndex(target) {
    const prev = new Set(
      this.#getRange(this.#current)
        .filter((index) => this.#hasMountedMedia(index)),
    );
    const next = new Set(
      this.#getRange(target),
    );

    const drop = prev.difference(next);
    const hydrate = next.difference(prev);

    for (const index of drop) {
      this.#unmountMedia(index);
    }

    await Promise.all(
      Array.from(hydrate)
        .map((index) => this.#mountMedia(index)),
    );

    this.#listenerProgress?.(this.#getMediaProgress(target));

    if (this.#playing) {
      this.#pauseMedia(this.#current);

      await this.#resumeMedia(target);
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

  /**
   * @param {{
   *  domList: Element,
   *  handles: FileSystemFileHandle[],
   *  listenerProgress: (progress: number) => void
   * }} params
   */
  constructor({ domList, handles, listenerProgress }) {
    this.#domList = domList;
    this.#handles = handles;
    this.#listenerProgress = listenerProgress;

    // Initialization

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
}
