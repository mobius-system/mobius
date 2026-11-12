#!/usr/bin/env python3
import sqlite3
import time

DATABASE = "/home/tianyi/imac-test/.deploy_data/data/agent-history-store.db"

def main():
    connection = sqlite3.connect(f"file:{DATABASE}?mode=ro", uri=True, timeout=5)
    previous_position = previous_time = None
    try:
        while True:
            position = connection.execute("SELECT last_rowid FROM history_search_state WHERE id=1").fetchone()[0]
            maximum = connection.execute("SELECT COALESCE(MAX(rowid), 0) FROM entries").fetchone()[0]
            pending = connection.execute("SELECT COUNT(*) FROM history_search_pending").fetchone()[0]
            now = time.monotonic()
            percent = position / maximum * 100 if maximum else 100
            speed = ((position - previous_position) / (now - previous_time) if previous_time else 0)
            eta = f"{(maximum - position) / speed / 60:.0f} min" if speed > 0 else "n/a"
            print(f"{time.strftime('%H:%M:%S')} | scan {percent:5.1f}% ({position:,}/{maximum:,}) | pending {pending:,} | {speed:.0f}/s | ETA {eta}", flush=True)
            metrics = connection.execute(
                "SELECT updated_at,cpu_percent,read_ms,tokenize_ms,write_ms,processed,skipped FROM history_search_metrics WHERE id=1"
            ).fetchone()
            if metrics:
                print(f"  sample {metrics[0]} | CPU {metrics[1]:.1f}% of one core | read/tokenize/write {metrics[2]:.0f}/{metrics[3]:.0f}/{metrics[4]:.0f} ms | processed {metrics[5]} | unchanged skipped {metrics[6]}", flush=True)
            previous_position, previous_time = position, now
            time.sleep(5)
    except KeyboardInterrupt:
        print("\nstopped watching; indexing continues in background")
    finally:
        connection.close()

if __name__ == "__main__":
    main()
