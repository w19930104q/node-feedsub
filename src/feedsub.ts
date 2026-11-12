import zlib from 'node:zlib';
import { type FeedItem, default as FeedMe } from 'feedme';
import miniget from 'miniget';
import NewsEmitter from 'newsemitter';
import { TypedEmitter } from 'tiny-typed-emitter';

// Used for the skipdays tag.
const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

type Options = FeedSub.Options;
type DefaultOptions = FeedSub.DefaultOptions;
type ReadCallback = (err: null | Error, items?: FeedItem[]) => void;

interface FeedSubEvents {
  error: (err: Error) => void;
  item: (item: FeedItem) => void;
  items: (items: FeedItem[]) => void;
}

class FeedSub extends TypedEmitter<FeedSubEvents> {
  static FeedSub = FeedSub;
  static default = FeedSub;
  public feed: string;
  public options: DefaultOptions;
  public news: NewsEmitter;
  public getOpts: miniget.Options & { headers: Record<string, string> };
  private _first: boolean;
  private _intervalid?: NodeJS.Timeout;
  // A fetch currently in progress, if any. Concurrent `read()` calls join it
  // so that only one request is ever made for the same feed at a time.
  private _pending: {
    waiters: Array<ReadCallback | undefined>;
    settled: boolean;
  } | null;

  constructor(feed: string, options?: Options) {
    super();
    this.feed = feed;
    this.options = Object.assign(
      {
        interval: 10,
        forceInterval: false,
        autoStart: false,
        emitOnStart: false,
        lastDate: null,
        history: [],
        maxHistory: 10,
        skipHours: false,
        hoursToSkip: null,
        skipDays: false,
        daysToSkip: null,
        requestOpts: {},
      },
      options,
    );

    // Create news emitter.
    this.news = new NewsEmitter({
      maxHistory: this.options.maxHistory,
      manageHistory: true,
      identifier: (item: FeedItem[]) => {
        const feedItem = item[0];
        return [
          feedItem.title,
          feedItem.link,
          feedItem.pubdate,
          feedItem.published,
          feedItem.updated,
        ].join(',');
      },
    });

    this.news.addHistory('item', this.options.history);
    this._first = (this.news.history.get('item') as Set<string>).size === 0;
    this._pending = null;
    this.getOpts = Object.assign(
      {
        headers: {} as Record<string, string>,
        acceptEncoding: {
          gzip: () => zlib.createGunzip(),
          deflate: () => zlib.createInflate(),
        },
      },
      this.options.requestOpts,
    );
    if (this.options.autoStart) {
      this.start(true);
    }
  }

  /**
   * Start calling the read function on interval.
   */
  start(readOnStart?: boolean) {
    this.stop();
    const ms = this.options.interval * 60000;
    this._intervalid = setInterval(this.read.bind(this), ms);
    if (readOnStart) {
      this.read();
    }
  }

  /**
   * Stop interval if any
   */
  stop() {
    clearInterval(this._intervalid);
  }

  /**
   * Reads feed and determines if there are any new items
   * emits new items through event `item`
   * if there are new items, emits `items` event at end with all items
   *
   * if callback is given, calls callback with all new items
   * even when there are 0.
   *
   * Nothing is committed until the whole response has been fetched and
   * parsed successfully: a failed request or a broken feed does not advance
   * conditional GET headers, `lastDate`, the item history or the polling
   * interval, and does not touch a previously working snapshot. Concurrent
   * calls share one request and are settled together, in call order.
   */
  read(callback?: ReadCallback) {
    // Join an in-progress fetch instead of starting another one.
    if (this._pending) {
      this._pending.waiters.push(callback);
      return;
    }

    const pending = { waiters: [callback], settled: false };
    this._pending = pending;

    let ended = false;
    let req: miniget.Stream;
    const items: FeedItem[] = [];
    let newItems: FeedItem[] = [];
    let sortOrder = 0;

    // Everything learned from this response is kept in local staging area
    // and only published to instance state once parsing fully succeeds.
    const stagedHeaders: Record<string, string> = {};
    let stagedDate: string | undefined;
    let stagedInterval: number | undefined;
    let stagedHoursToSkip: number[] | undefined;
    let stagedDaysToSkip: string[] | undefined;

    // Shadow copy of the replayable item history. Dedup decisions during
    // parsing are made against it, so an early stop still works, while the
    // real history is only replaced once the whole response is valid.
    // Like NewsEmitter with `manageHistory`, lookups never mutate it: the
    // committed snapshot is updated atomically from `newItems` at the end.
    const shadowHistory = new Set<string>(
      this.news.history.get('item') as Set<string>,
    );
    // Returns whether the item is news, i.e. absent from both the committed
    // snapshot and everything already encountered within this response.
    const seenInResponse = new Set<string>();
    const isNewItem = (item: FeedItem) => {
      const key = this.news.options.identifier([item]);
      if (shadowHistory.has(key) || seenInResponse.has(key)) {
        return false;
      }
      seenInResponse.add(key);
      return true;
    };

    const settle = (err?: Error) => {
      if (pending.settled) {
        return;
      }
      pending.settled = true;
      // Release the in-flight slot before any event or callback can start
      // another read, otherwise a read triggered from a listener would
      // wrongly join this already-finished fetch.
      this._pending = null;

      if (err) {
        // Notify every concurrent caller, in the order they called `read()`.
        // A single failed fetch yields at most one `error` event for the
        // callers that did not provide a callback.
        let errorEmitted = false;
        for (const waiter of pending.waiters) {
          if (typeof waiter === 'function') {
            waiter(err);
          } else if (!errorEmitted) {
            errorEmitted = true;
            this.emit('error', err);
          }
        }
      }
    };

    const deliver = (resultItems: FeedItem[]) => {
      // Events fire once per effective fetch, one item at a time and in
      // the feed's order, shared by every concurrent caller.
      for (const item of resultItems) {
        this.emit('item', item);
      }
      this.emit('items', resultItems);
      // Callbacks run after the events, one waiter at a time and in order.
      for (const waiter of pending.waiters) {
        if (typeof waiter === 'function') {
          waiter(null, resultItems);
        }
      }
    };

    const error = (err: Error) => {
      if (ended) {
        return;
      }
      ended = true;
      // Failure must not advance any state: headers, history, `lastDate`,
      // `_first`, the interval and the replayable snapshot stay untouched.
      req.destroy();
      settle(err);
    };

    const success = (fullyParsed: boolean) => {
      if (ended) {
        return;
      }
      ended = true;

      if (fullyParsed) {
        // Full response fetched and parsed: publish the staged snapshot.
        if (stagedHeaders['If-Modified-Since']) {
          this.getOpts.headers['If-Modified-Since'] =
            stagedHeaders['If-Modified-Since'];
        }
        if (stagedHeaders['If-None-Match']) {
          this.getOpts.headers['If-None-Match'] =
            stagedHeaders['If-None-Match'];
        }
        if (stagedDate !== undefined) {
          this.options.lastDate = stagedDate;
        }
        if (stagedHoursToSkip !== undefined) {
          this.options.hoursToSkip = stagedHoursToSkip;
        }
        if (stagedDaysToSkip !== undefined) {
          this.options.daysToSkip = stagedDaysToSkip;
        }
        if (stagedInterval !== undefined) {
          this.options.interval = stagedInterval;
        }

        // Only a document consumed in full gets its unknown ordering
        // normalized; an early dedup stop keeps the insertion order.
        if (sortOrder <= 0) {
          newItems.reverse();
        }
        // Atomically publish the new history. Rebuild it from the committed
        // snapshot plus this response's items, going through NewsEmitter's
        // own LRU truncation so `maxHistory` is honored exactly as before.
        const committedHistory = new Set(shadowHistory);
        this.news.history.set('item', committedHistory);
        this.news.addHistory(
          'item',
          newItems.map((item) => [item]),
        );
        if (this._first && !this.options.emitOnStart) {
          newItems = [];
        }

        // Restart the timer only after the new interval is committed.
        if (
          stagedInterval !== undefined &&
          this.options.autoStart &&
          this._intervalid
        ) {
          this.start(false);
        }
        this._first = false;
      }

      if (req) {
        req.destroy();
      }
      // Mark the fetch finished, releasing the concurrency slot, before
      // emitting anything: a read started from a listener must be fresh.
      settle();
      deliver(newItems);
    };

    // If skipHours or skipDays are enabled and feed provides hours/days
    // to skip and it's currently one of those hours/days, abort.
    const now = new Date();
    const shouldSkip = () => {
      if (this._first && this.options.emitOnStart) {
        return false;
      }
      if (
        this.options.hoursToSkip &&
        this.options.hoursToSkip.indexOf(now.getHours()) !== -1
      ) {
        return true;
      }
      if (
        this.options.daysToSkip?.some((day) => {
          return day.toLowerCase() === DAYS[now.getDay()];
        })
      ) {
        return true;
      }
      return false;
    };

    if (shouldSkip()) {
      return success(false);
    }

    req = miniget(this.feed, this.getOpts);
    req.on('response', (res) => {
      // Check if not modified code is sent back
      // in this case, the body will be empty.
      if (res.statusCode === 304) {
        // 304 confirms the previously committed snapshot is still current:
        // nothing new to commit, keep every existing header as-is.
        return success(false);
      }

      // Stage headers for conditional get; committed only on full success.
      if (res.headers['last-modified']) {
        stagedHeaders['If-Modified-Since'] = res.headers[
          'last-modified'
        ] as string;
      }
      if (res.headers.etag) {
        stagedHeaders['If-None-Match'] = res.headers.etag as string;
      }

      // Save date.
      let date: string;
      const getdate = (text: string) => (date = text);

      // Create feed parser.
      const parser = new FeedMe();
      parser.on('error', error);

      // Try to get date from one of the fields.
      parser.once('pubdate', getdate);
      parser.once('lastbuilddate', getdate);
      parser.once('updated', getdate);

      // Change interval time if ttl available.
      if (!this.options.forceInterval) {
        parser.once('ttl', (minutes) => {
          const parsedMinutes = parseInt(minutes, 10);

          // Only update if ttl is longer than requested interval.
          if (parsedMinutes > this.options.interval) {
            stagedInterval = parsedMinutes;
          }
        });
      }

      // Listen for skipHours if enabled.
      if (this.options.skipHours && !this.options.hoursToSkip) {
        parser.once('skiphours', (data) => {
          stagedHoursToSkip = [].concat(data.hour).map((h) => parseInt(h, 10));
        });
      }

      // Listen for skipDays if enabled.
      if (this.options.skipDays !== false && !this.options.daysToSkip) {
        parser.once('skipdays', (data) => {
          stagedDaysToSkip = [].concat(data.day);
        });
      }

      // Compare date when first item is encountered.
      const firstitem = (item: FeedItem) => {
        if (shouldSkip()) {
          // Stop consuming the body but wait for the stream to finish so
          // the commit only happens after a complete, valid response.
          parser.removeListener('item', getItem);
          return;
        }

        // Continue if dates differ.
        if (date) {
          stagedDate = date;
        }
        parser.on('item', getItem);
        getItem(item);
      };

      parser.once('item', firstitem);

      const getItemDate = (item: FeedItem) =>
        Date.parse(item.pubdate as string) ||
        Date.parse(item.published as string) ||
        0;

      const getItem = (item: FeedItem) => {
        if (sortOrder === 0) {
          items.push(item);
          sortOrder = getItemDate(item) - getItemDate(items[0]);
          if (sortOrder < 0) {
            items.forEach(getOlderItem);
          } else if (sortOrder > 0) {
            items.forEach(getNewerItem);
          }
        } else if (sortOrder < 0) {
          getOlderItem(item);
        } else {
          getNewerItem(item);
        }
      };

      // Set once an already-read item is reached. Streaming item handlers
      // detach themselves and the finish-time fallback stops iterating, so
      // the rest of the document is treated as previously consumed.
      let stopped = false;

      const getOlderItem = (item: FeedItem) => {
        if (this._first) {
          newItems.push(item);
        } else if (!ended && !stopped) {
          if (isNewItem(item)) {
            newItems.push(item);
          } else {
            // Check if this item has already been read in previous requests
            // if it has, then stop parsing the rest of the document.
            stopped = true;
            parser.removeListener('item', getItem);
          }
        }
      };

      let foundPrevItem = false;
      const getNewerItem = (item: FeedItem) => {
        if (this._first) {
          newItems.push(item);
        } else if (!foundPrevItem && !isNewItem(item)) {
          foundPrevItem = true;
        } else if (foundPrevItem && isNewItem(item)) {
          newItems.push(item);
        }
      };

      req.pipe(parser);

      parser.on('finish', () => {
        if (ended) {
          return;
        }
        // Process items in descending order if no order found at end.
        if (sortOrder === 0 && newItems.length === 0) {
          for (const item of items) {
            if (stopped) {
              break;
            }
            getOlderItem(item);
          }
        }
        // The whole response was fetched and parsed without errors:
        // safe to publish the staged state, history and interval.
        success(true);
      });
    });

    req.on('error', error);
  }
}

namespace FeedSub {
  export interface Options {
    interval?: number;
    forceInterval?: boolean;
    autoStart?: boolean;
    emitOnStart?: boolean;
    lastDate?: null | string;
    history?: string[];
    maxHistory?: number;
    skipHours?: boolean;
    hoursToSkip?: number[];
    skipDays?: boolean;
    daysToSkip?: string[];
    requestOpts?: miniget.Options;
  }

  export type DefaultOptions = Required<Options>;
  export type FeedItem = import('feedme').FeedItem;
}

// Statically recognizable exports for Node.js cjs-module-lexer (ESM named import support)
module.exports = FeedSub;
module.exports.default = FeedSub;
module.exports.FeedSub = FeedSub;

export = FeedSub;
