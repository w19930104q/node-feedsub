import assert from 'node:assert';
import { join } from 'node:path';
import nock from 'nock';
import sinon from 'sinon';
import FeedSub from '..';

const rss2old = join(__dirname, 'assets', 'rss2old.xml');
const rss2new = join(__dirname, 'assets', 'rss2new.xml');
const badfeed = join(__dirname, 'assets', 'badfeed.xml');

// A well-formed feed that advertises a long ttl and conditional GET headers.
const ttlFeed = (ttl: number) =>
  `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Liftoff News</title>
    <link>http://liftoff.msfc.nasa.gov/</link>
    <description>Liftoff to Space Exploration.</description>
    <pubDate>Tue, 10 Jun 2003 04:00:00 GMT</pubDate>
    <ttl>${ttl}</ttl>
    <item>
      <title>Star City</title>
      <link>http://liftoff.msfc.nasa.gov/news/2003/news-starcity.asp</link>
      <pubDate>Tue, 03 Jun 2003 09:39:21 GMT</pubDate>
    </item>
  </channel>
</rss>`;

// The ttl tag is emitted before the document breaks, which is exactly when
// an eager implementation would corrupt the polling interval.
const truncatedTtlFeed = (ttl: number) =>
  `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Liftoff News</title>
    <pubDate>Tue, 10 Jun 2003 04:00:00 GMT</pubDate>
    <ttl>${ttl}</ttl>
    <item><title>Star City</title><uhoh<<<<`;

const host = 'http://recovery.info';
const path = '/rss';
const etag = '"recover-etag"';
const lastModified = 'Tue, 10 Jun 2003 04:00:00 GMT';
const headers = { 'last-modified': lastModified, etag };

describe('Transactional refresh: commit only on full success', () => {
  afterEach(() => {
    nock.cleanAll();
    sinon.restore();
  });

  describe('After a broken response', () => {
    it('Keeps conditional GET headers, lastDate and history on HTTP 500, then recovers', (done) => {
      // miniget does not retry plain 500 responses: the error arrives after
      // a single, unvalidated attempt.
      const failScope = nock(host).get(path).reply(500, 'boom');
      // The recovery request must not carry any conditional headers.
      const okScope = nock(host)
        .get(path)
        .matchHeader('if-modified-since', (v: string) => !v)
        .matchHeader('if-none-match', (v: string) => !v)
        .replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });

      reader.read((err) => {
        assert.ok(err, 'first read fails');
        assert.equal(/500/.test(err.message), true);
        failScope.done();

        // Nothing unvalidated was committed.
        assert.equal(reader.getOpts.headers['If-Modified-Since'], undefined);
        assert.equal(reader.getOpts.headers['If-None-Match'], undefined);
        assert.equal(reader.options.lastDate, null);
        assert.equal((reader.news.history.get('item') as Set<string>).size, 0);

        reader.read((err, items) => {
          assert.ifError(err);
          assert.equal(items?.length, 4);
          assert.equal(
            reader.getOpts.headers['If-Modified-Since'],
            lastModified,
          );
          assert.equal(reader.getOpts.headers['If-None-Match'], etag);
          assert.equal(
            (reader.news.history.get('item') as Set<string>).size,
            4,
          );
          okScope.done();
          done();
        });
      });
    });

    it('Keeps previously committed snapshot on truncated XML, then recovers with new items', (done) => {
      const scope1 = nock(host).get(path).replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });
      const itemSpy = sinon.spy();
      reader.on('item', itemSpy);

      reader.read((err, items) => {
        assert.ifError(err);
        assert.equal(items?.length, 4);
        assert.equal(itemSpy.callCount, 4);
        scope1.done();

        const committedHeaders = {
          'If-Modified-Since': reader.getOpts.headers['If-Modified-Since'],
          'If-None-Match': reader.getOpts.headers['If-None-Match'],
        };
        const historySize = (reader.news.history.get('item') as Set<string>)
          .size;

        itemSpy.resetHistory();
        const badScope = nock(host)
          .get(path)
          .replyWithFile(200, badfeed, headers);

        reader.read((err) => {
          assert.ok(err, 'truncated XML fails');
          assert.equal(/Unexpected end/.test(err.message), true);
          badScope.done();

          // Snapshot and headers must be exactly the committed ones.
          assert.equal(
            reader.getOpts.headers['If-Modified-Since'],
            committedHeaders['If-Modified-Since'],
          );
          assert.equal(
            reader.getOpts.headers['If-None-Match'],
            committedHeaders['If-None-Match'],
          );
          assert.equal(
            (reader.news.history.get('item') as Set<string>).size,
            historySize,
          );
          assert.equal(itemSpy.callCount, 0);

          const scope3 = nock(host)
            .get(path)
            .replyWithFile(200, rss2new, headers);

          reader.read((err, items) => {
            assert.ifError(err);
            assert.equal(items?.length, 1, 'new item still detected');
            assert.equal(itemSpy.callCount, 1);
            // Same title as an old item, but a newer pubdate makes it news.
            assert.equal(items?.[0].title, 'Star City');
            assert.equal(items?.[0].pubdate, 'Wed, 11 Jun 2003 09:39:21 GMT');
            scope3.done();
            done();
          });
        });
      });
    });

    it('Does not treat unparseable content as a valid snapshot', (done) => {
      const badScope = nock(host)
        .get(path)
        .reply(200, 'this is not a feed at all', headers);
      const okScope = nock(host).get(path).replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });

      reader.read((err) => {
        assert.ok(err);
        badScope.done();
        assert.equal(
          reader.getOpts.headers['If-None-Match'],
          undefined,
          'etag from broken body not committed',
        );

        reader.read((err, items) => {
          assert.ifError(err);
          assert.equal(items?.length, 4);
          assert.equal(reader.getOpts.headers['If-None-Match'], etag);
          okScope.done();
          done();
        });
      });
    });
  });

  describe('Concurrent read() calls', () => {
    it('Produce a single effective fetch and share its items in call order', (done) => {
      const scope = nock(host).get(path).replyWithFile(200, rss2old);

      const reader = new FeedSub(host + path, { emitOnStart: true });
      const itemSpy = sinon.spy();
      const itemsSpy = sinon.spy();
      reader.on('item', itemSpy);
      reader.on('items', itemsSpy);

      const order: string[] = [];
      let pending = 3;
      const cb =
        (name: string) => (err: null | Error, items?: FeedSub.FeedItem[]) => {
          assert.ifError(err);
          order.push(name);
          assert.equal(items?.length, 4);
          if (--pending === 0) {
            scope.done();
            assert.deepEqual(order, ['first', 'second', 'third']);
            assert.equal(itemSpy.callCount, 4, 'one item event per item');
            assert.equal(itemsSpy.callCount, 1, 'one items event per fetch');
            assert.equal(
              (reader.news.history.get('item') as Set<string>).size,
              4,
              'history committed once',
            );
            done();
          }
        };

      reader.read(cb('first'));
      reader.read(cb('second'));
      reader.read(cb('third'));
    });

    it('Share one failed request and every caller receives the error', (done) => {
      const scope = nock(host).get(path).reply(500, 'boom');

      const reader = new FeedSub(host + path, { emitOnStart: true });
      const errors: string[] = [];
      const cb = (name: string) => (err: null | Error) => {
        if (err) {
          errors.push(name);
        }
      };

      reader.read(cb('first'));
      reader.read(cb('second'));

      setImmediate(() => {
        scope.done();
        assert.deepEqual(errors, ['first', 'second']);
        assert.equal(reader.getOpts.headers['If-None-Match'], undefined);
        assert.equal((reader.news.history.get('item') as Set<string>).size, 0);
        done();
      });
    });

    it('Emit a single error event for a failed fetch without callbacks', (done) => {
      const scope = nock(host).get(path).reply(500, 'boom');

      const reader = new FeedSub(host + path, { emitOnStart: true });
      let errorCount = 0;
      reader.on('error', () => {
        errorCount++;
      });

      // Three concurrent reads, none with a callback: still one request
      // and at most one `error` event for the whole fetch.
      reader.read();
      reader.read();
      reader.read();

      setImmediate(() => {
        scope.done();
        assert.equal(errorCount, 1);
        done();
      });
    });

    it('Are followed by another read that fetches again normally', (done) => {
      const scope1 = nock(host).get(path).replyWithFile(200, rss2old);
      const scope2 = nock(host).get(path).replyWithFile(200, rss2new);

      const reader = new FeedSub(host + path, { emitOnStart: true });

      reader.read(() => {
        reader.read((err, items) => {
          assert.ifError(err);
          assert.equal(items?.length, 1);
          scope1.done();
          scope2.done();
          done();
        });
      });
      reader.read();
    });
  });

  describe('TTL rollback', () => {
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => (clock = sinon.useFakeTimers()));
    afterEach(() => clock.restore());

    it('Does not change the polling interval when the feed is broken', (done) => {
      const originalInterval = 10;
      const reader = new FeedSub(host + path, {
        autoStart: true,
        interval: originalInterval,
      });
      after(() => reader.stop());

      const badScope = nock(host).get(path).reply(200, truncatedTtlFeed(30));

      reader.on('error', (err) => {
        assert.ok(err);
        badScope.done();
        assert.equal(
          reader.options.interval,
          originalInterval,
          'ttl from broken feed rolled back',
        );

        const okScope = nock(host).get(path).reply(200, ttlFeed(30));

        reader.read((err) => {
          assert.ifError(err);
          okScope.done();
          assert.equal(
            reader.options.interval,
            30,
            'valid feed still able to extend interval',
          );
          done();
        });
      });
    });
  });

  describe('304 Not Modified', () => {
    it('Commits nothing and keeps the existing snapshot and interval', (done) => {
      const scope1 = nock(host).get(path).replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });
      const itemSpy = sinon.spy();
      reader.on('item', itemSpy);

      reader.read((err, items) => {
        assert.ifError(err);
        assert.equal(items?.length, 4);
        scope1.done();

        const historySize = (reader.news.history.get('item') as Set<string>)
          .size;
        itemSpy.resetHistory();

        const scope2 = nock(host)
          .get(path)
          .matchHeader('if-none-match', etag)
          .matchHeader('if-modified-since', lastModified)
          .reply(304, '');

        reader.read((err, items) => {
          assert.ifError(err);
          assert.deepEqual(items, []);
          scope2.done();

          assert.equal(itemSpy.callCount, 0);
          assert.equal(
            (reader.news.history.get('item') as Set<string>).size,
            historySize,
          );
          assert.equal(reader.getOpts.headers['If-None-Match'], etag);
          assert.equal(
            reader.getOpts.headers['If-Modified-Since'],
            lastModified,
          );
          done();
        });
      });
    });

    it('Still delivers new items in order once the feed changes again', (done) => {
      const scope1 = nock(host).get(path).replyWithFile(200, rss2old, headers);
      const scope2 = nock(host)
        .get(path)
        .matchHeader('if-none-match', etag)
        .reply(304, '');
      const scope3 = nock(host).get(path).replyWithFile(200, rss2new, {
        'last-modified': lastModified,
        etag: '"new-etag"',
      });

      const reader = new FeedSub(host + path, { emitOnStart: true });
      const seen: FeedSub.FeedItem[] = [];
      reader.on('item', (item) => seen.push(item));

      reader.read((err) => {
        assert.ifError(err);
        reader.read((err, items) => {
          assert.ifError(err);
          assert.deepEqual(items, []);
          const seenBeforeUpdate = seen.length;
          reader.read((err, items) => {
            assert.ifError(err);
            assert.equal(items?.length, 1);
            // The new item shares its title with an old one but has a
            // newer pubdate; ordering and dedup must still work after 304.
            assert.equal(seen.length, seenBeforeUpdate + 1);
            assert.equal(seen[seen.length - 1].title, 'Star City');
            assert.equal(
              seen[seen.length - 1].pubdate,
              'Wed, 11 Jun 2003 09:39:21 GMT',
            );
            assert.deepEqual(items, seen.slice(seenBeforeUpdate));
            assert.equal(reader.getOpts.headers['If-None-Match'], '"new-etag"');
            scope1.done();
            scope2.done();
            scope3.done();
            done();
          });
        });
      });
    });
  });

  describe('Retries', () => {
    it('Exhausts miniget retries on persistent 503 without committing, then succeeds', (done) => {
      // miniget's default maxRetries=2 means one initial attempt plus
      // two retries. Separate interceptors are needed because nock does
      // not re-match `.times()` interceptors on retried requests.
      const failScopes = Array.from({ length: 3 }, () =>
        nock(host).get(path).reply(503, 'slow down'),
      );
      const okScope = nock(host).get(path).replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });

      reader.read((err) => {
        assert.ok(err);
        assert.equal(/Status code: 503/.test(err.message), true);
        failScopes.forEach((scope) => {
          scope.done();
        });
        assert.equal(reader.options.lastDate, null);
        assert.equal(reader.getOpts.headers['If-None-Match'], undefined);
        assert.equal((reader.news.history.get('item') as Set<string>).size, 0);

        reader.read((err, items) => {
          assert.ifError(err);
          assert.equal(items?.length, 4);
          okScope.done();
          done();
        });
      });
    }).timeout(10000);

    it('Succeeds when the server recovers between retries', (done) => {
      const failScopes = [
        nock(host).get(path).reply(503, 'slow down'),
        nock(host).get(path).reply(503, 'slow down'),
      ];
      const okScope = nock(host).get(path).replyWithFile(200, rss2old, headers);

      const reader = new FeedSub(host + path, { emitOnStart: true });

      reader.read((err, items) => {
        assert.ifError(err);
        assert.equal(items?.length, 4);
        assert.equal(
          reader.getOpts.headers['If-None-Match'],
          etag,
          'committed only after the successful attempt',
        );
        assert.equal((reader.news.history.get('item') as Set<string>).size, 4);
        failScopes.forEach((scope) => {
          scope.done();
        });
        okScope.done();
        done();
      });
    }).timeout(10000);
  });
});
