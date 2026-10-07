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

/**
 * @typedef {"video"|"image"} MediaKind
 */

/**
 * @typedef {{kind: MediaKind, fh: FileSystemFileHandle}} MediaFile
 */

/**
 * @param {FileSystemFileHandle} fh
 * @returns {MediaFile | null}
 */
function parseMediaFile(fh) {
  if (/\.(?:mp4|webm|ogv|ogg)$/i.test(fh.name)) {
    return { kind: "video", fh };
  } else if (/\.(?:jpg|jpeg|png|gif|svg|webp|avif|bmp)$/i.test(fh.name)) {
    return { kind: "image", fh };
  } else {
    return null;
  }
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

const menu = getElementByIdStrict("menu");

getElementByIdStrict("toggle-fullscreen")
  .addEventListener("click", async () => {
    menu.hidePopover();

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

    const mediaFiles = (await Array.fromAsync(findAllFiles(directory)))
      .map((fh) => parseMediaFile(fh))
      .filter((mf) => mf !== null);

    toast(
      `Loaded ${mediaFiles.length} files in ${
        (performance.now() - t).toFixed(0)
      }ms`,
    );

    feed?.dispose();

    feed = new Feed({
      domList: getElementByIdStrict("media-list"),
      handles: shuffle(mediaFiles),
      listenerProgress: (progress) => {
        /** @type {HTMLElement | null} */
        const element = document.querySelector(".progress > .fill");
        if (element) {
          element.style.width = `${100 * progress}%`;
        }
      },
    });
  });

class Feed {
  /** @type {Element} */
  #domList;
  /** @type {MediaFile[]} */
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
   * @template T
   * @param {number} index
   * @param {Record<MediaKind, () => T>} handler
   * @returns {T}
   */
  #visitMedia(index, handler) {
    return handler[this.#handles[index].kind]();
  }

  /**
   * @param {number} index
   */
  async #mountMedia(index) {
    return this.#visitMedia(index, {
      video: async () => {
        const file = await this.#handles[index].fh.getFile();

        const video = document.createElement("video");
        video.src = URL.createObjectURL(file);
        video.loop = true;

        const update = () => {
          this.#listenerProgress?.(video.currentTime / video.duration);
          if (!video.paused) {
            video.requestVideoFrameCallback(update);
          }
        };

        video.addEventListener("play", update);

        const item = this.#domItems[index];
        item.appendChild(video);
      },
      image: async () => {
        const file = await this.#handles[index].fh.getFile();

        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);

        const item = this.#domItems[index];
        item.appendChild(img);
      },
    });
  }

  /**
   * @param {number} index
   */
  #unmountMedia(index) {
    return this.#visitMedia(index, {
      video: () => {
        const video = this.#domItems[index].querySelector("video");
        if (video) {
          URL.revokeObjectURL(video.src);
          video.remove();
        }
      },
      image: () => {
        const img = this.#domItems[index].querySelector("img");
        if (img) {
          URL.revokeObjectURL(img.src);
          img.remove();
        }
      },
    });
  }

  /**
   * @param {number} index
   */
  #hasMountedMedia(index) {
    return this.#visitMedia(index, {
      video: () => {
        return this.#domItems[index]?.querySelector("video") !== null;
      },
      image: () => {
        return this.#domItems[index]?.querySelector("img") !== null;
      },
    });
  }

  /**
   * @param {number} index
   */
  #getMediaProgress(index) {
    return this.#visitMedia(index, {
      video: () => {
        const video = this.#domItems[index]?.querySelector("video");
        if (video) {
          return video.currentTime / video.duration;
        } else {
          return 0;
        }
      },
      image: () => {
        return 0;
      },
    });
  }

  /**
   * @param {number} index
   */
  #pauseMedia(index) {
    return this.#visitMedia(index, {
      video: () => {
        const video = this.#domItems[index]?.querySelector("video");
        return video?.pause();
      },
      image: () => {},
    });
  }

  /**
   * @param {number} index
   */
  #resumeMedia(index) {
    return this.#visitMedia(index, {
      video: async () => {
        const video = this.#domItems[index]?.querySelector("video");
        return await video?.play();
      },
      image: async () => {},
    });
  }

  /**
   * @param {number} target
   */
  #onActivateItemIndex = async (target) => {
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
  };

  /**
   * @param {IntersectionObserverEntry[]} entries
   */
  #onIntersectionObserved = (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const intersectingIndex = this.#domItems.indexOf(entry.target);
        this.#onActivateItemIndex(intersectingIndex);
      }
    });
  };

  #onListClick = async () => {
    if (this.#playing) {
      this.#pauseMedia(this.#current);
      this.#playing = false;
    } else {
      await this.#resumeMedia(this.#current);
      this.#playing = true;
    }
  };

  #onViewResize = () => {
    const item = this.#domItems[this.#current];

    item?.scrollIntoView({
      block: "start",
      behavior: "instant",
    });
  };

  dispose() {
    this.#observer.disconnect();
    this.#domList.replaceChildren();
    this.#domList.removeEventListener("click", this.#onListClick);
    window.visualViewport?.removeEventListener("resize", this.#onViewResize);
  }

  #createItemDOM() {
    const item = document.createElement("li");
    item.classList.add("item");
    return item;
  }

  /**
   * @param {{
   *  domList: Element,
   *  handles: MediaFile[],
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

    this.#observer = new IntersectionObserver(
      this.#onIntersectionObserved,
      {
        root: this.#domList,
        threshold: 0.6,
      },
    );

    for (const child of this.#domItems) {
      this.#observer.observe(child);
    }

    this.#domList.addEventListener("click", this.#onListClick);
    window.visualViewport?.addEventListener("resize", this.#onViewResize);
  }
}
