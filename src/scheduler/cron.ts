type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun ... 6=Sat

type ParsedCron = {
  minutes: number[]; // sorted, unique
  hours: number[]; // sorted, unique
  weekdays: Set<Weekday> | null; // null means "*"
};

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
};

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const tz = String(timeZone ?? "").trim();
  if (!tz) {
    throw new Error("timezone is required");
  }
  const cached = DTF_CACHE.get(tz);
  if (cached) {
    return cached;
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
    hourCycle: "h23",
  });
  DTF_CACHE.set(tz, dtf);
  return dtf;
}

const WEEKDAY_MAP: Record<string, Weekday> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseIntStrict(value: string, field: string): number {
  const trimmed = String(value ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: ${trimmed}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field}: ${trimmed}`);
  }
  return parsed;
}

function uniqSorted(values: number[]): number[] {
  const out = Array.from(new Set(values)).sort((a, b) => a - b);
  return out;
}

export function validateTimeZone(timeZone: string): { ok: true } | { ok: false; reason: string } {
  try {
    getDateTimeFormat(timeZone);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}

export function parseSupportedCron(cron: string): { ok: true; parsed: ParsedCron } | { ok: false; reason: string } {
  const raw = String(cron ?? "").trim();
  if (!raw) {
    return { ok: false, reason: "cron is required" };
  }
  const parts = raw.split(/\s+/g).filter(Boolean);
  if (parts.length !== 5) {
    return { ok: false, reason: `cron must have 5 fields, got ${parts.length}` };
  }
  const [minField, hourField, domField, monField, dowField] = parts as [string, string, string, string, string];

  if (domField !== "*" || monField !== "*") {
    return { ok: false, reason: "Only dom='*' and mon='*' are supported" };
  }

  const minutes = (() => {
    const trimmed = minField.trim();
    if (/^\d+$/.test(trimmed)) {
      const minute = parseIntStrict(trimmed, "minute");
      if (minute < 0 || minute > 59) {
        throw new Error("minute out of range");
      }
      return [minute];
    }
    const stepMatch = /^\*\/(\d+)$/.exec(trimmed);
    if (stepMatch) {
      const step = parseIntStrict(stepMatch[1] ?? "", "minute step");
      if (step <= 0 || step > 60) {
        throw new Error("minute step out of range");
      }
      if (60 % step !== 0) {
        throw new Error("minute step must divide 60");
      }
      const out: number[] = [];
      for (let m = 0; m < 60; m += step) {
        out.push(m);
      }
      return out;
    }
    throw new Error("minute must be N or */N");
  })();

  const hours = (() => {
    const trimmed = hourField.trim();
    if (trimmed === "*") {
      return Array.from({ length: 24 }, (_, i) => i);
    }
    if (/^\d+$/.test(trimmed)) {
      const hour = parseIntStrict(trimmed, "hour");
      if (hour < 0 || hour > 23) {
        throw new Error("hour out of range");
      }
      return [hour];
    }
    throw new Error("hour must be N or *");
  })();

  const weekdays = (() => {
    const trimmed = dowField.trim();
    if (trimmed === "*") {
      return null;
    }
    const set = new Set<Weekday>();
    for (const tokenRaw of trimmed.split(",").map((t) => t.trim()).filter(Boolean)) {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(tokenRaw);
      if (rangeMatch) {
        const startRaw = parseIntStrict(rangeMatch[1] ?? "", "dow range start");
        const endRaw = parseIntStrict(rangeMatch[2] ?? "", "dow range end");
        if (startRaw < 0 || startRaw > 7 || endRaw < 0 || endRaw > 7) {
          throw new Error("dow out of range (0-7)");
        }
        if (endRaw < startRaw) {
          throw new Error("dow range must be increasing");
        }
        for (let v = startRaw; v <= endRaw; v += 1) {
          const mapped = (v === 7 ? 0 : v) as Weekday;
          set.add(mapped);
        }
        continue;
      }
      if (!/^\d+$/.test(tokenRaw)) {
        throw new Error("dow must be N, N-N, or list");
      }
      const valueRaw = parseIntStrict(tokenRaw, "dow");
      if (valueRaw < 0 || valueRaw > 7) {
        throw new Error("dow out of range (0-7)");
      }
      const mapped = (valueRaw === 7 ? 0 : valueRaw) as Weekday;
      set.add(mapped);
    }
    if (set.size === 0) {
      throw new Error("dow set is empty");
    }
    return set;
  })();

  return { ok: true, parsed: { minutes: uniqSorted(minutes), hours: uniqSorted(hours), weekdays } };
}

function getZonedParts(tsMs: number, timeZone: string): ZonedParts {
  const dtf = getDateTimeFormat(timeZone);
  const parts = dtf.formatToParts(new Date(tsMs));

  const pick = (type: string): string => {
    const found = parts.find((p) => p.type === type)?.value;
    if (!found) {
      throw new Error(`Intl parts missing ${type}`);
    }
    return found;
  };

  const weekdayText = pick("weekday").trim();
  const weekday = WEEKDAY_MAP[weekdayText];
  if (weekday == null) {
    throw new Error(`Unsupported weekday token: ${weekdayText}`);
  }

  return {
    year: parseIntStrict(pick("year"), "year"),
    month: parseIntStrict(pick("month"), "month"),
    day: parseIntStrict(pick("day"), "day"),
    hour: parseIntStrict(pick("hour"), "hour"),
    minute: parseIntStrict(pick("minute"), "minute"),
    second: parseIntStrict(pick("second"), "second"),
    weekday,
  };
}

function wallClockUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, 0);
}

function addWallClockMinutes(clock: Omit<WallClock, "second">, minutes: number): Omit<WallClock, "second"> {
  const base = new Date(Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, 0, 0));
  base.setUTCMinutes(base.getUTCMinutes() + minutes);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour: base.getUTCHours(),
    minute: base.getUTCMinutes(),
  };
}

function weekdayForDate(year: number, month: number, day: number): Weekday {
  const weekday = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).getUTCDay();
  return weekday as Weekday;
}

function isSameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

function zonedDateTimeToUtcMs(desired: WallClock, timeZone: string): number {
  let guess = wallClockUtcMs(desired);
  for (let i = 0; i < 4; i += 1) {
    const actual = getZonedParts(guess, timeZone);
    const actualWall: WallClock = {
      year: actual.year,
      month: actual.month,
      day: actual.day,
      hour: actual.hour,
      minute: actual.minute,
      second: actual.second,
    };
    if (isSameWallClock(actualWall, desired)) {
      return guess;
    }
    const diff = wallClockUtcMs(desired) - wallClockUtcMs(actualWall);
    guess += diff;
  }
  const final = getZonedParts(guess, timeZone);
  const finalWall: WallClock = {
    year: final.year,
    month: final.month,
    day: final.day,
    hour: final.hour,
    minute: final.minute,
    second: final.second,
  };
  if (isSameWallClock(finalWall, desired)) {
    return guess;
  }
  throw new Error("Failed to convert zoned time to UTC");
}

function findNextInSorted(sorted: number[], start: number): number | null {
  for (const value of sorted) {
    if (value >= start) {
      return value;
    }
  }
  return null;
}

export function computeNextCronRunAt(options: { cron: string; timezone: string; afterMs: number }): number {
  const parsedResult = parseSupportedCron(options.cron);
  if (!parsedResult.ok) {
    throw new Error(parsedResult.reason);
  }
  const tz = String(options.timezone ?? "").trim();
  const tzValid = validateTimeZone(tz);
  if (!tzValid.ok) {
    throw new Error(tzValid.reason);
  }

  const { minutes, hours, weekdays } = parsedResult.parsed;
  const afterMs = Math.floor(options.afterMs);
  const after = getZonedParts(afterMs, tz);
  let cursor = addWallClockMinutes(
    { year: after.year, month: after.month, day: after.day, hour: after.hour, minute: after.minute },
    1,
  );

  const maxDays = 370;
  for (let dayOffset = 0; dayOffset < maxDays; dayOffset += 1) {
    const weekday = weekdayForDate(cursor.year, cursor.month, cursor.day);
    if (weekdays && !weekdays.has(weekday)) {
      cursor = addWallClockMinutes({ year: cursor.year, month: cursor.month, day: cursor.day, hour: 0, minute: 0 }, 24 * 60);
      continue;
    }

    const candidate = (() => {
      for (const hour of hours) {
        if (hour < cursor.hour) {
          continue;
        }
        const minuteStart = hour === cursor.hour ? cursor.minute : 0;
        const minute = findNextInSorted(minutes, minuteStart);
        if (minute == null) {
          continue;
        }
        return { year: cursor.year, month: cursor.month, day: cursor.day, hour, minute };
      }
      return null;
    })();

    if (!candidate) {
      cursor = addWallClockMinutes({ year: cursor.year, month: cursor.month, day: cursor.day, hour: 0, minute: 0 }, 24 * 60);
      continue;
    }

    const desired: WallClock = { ...candidate, second: 0 };
    let utcMs = zonedDateTimeToUtcMs(desired, tz);

    if (utcMs <= afterMs) {
      // Handle DST fallback ambiguity: try later UTC instants that still map to the same wall-clock time.
      const desiredParts = desired;
      for (let hoursAhead = 1; hoursAhead <= 3; hoursAhead += 1) {
        const alt = utcMs + hoursAhead * 60 * 60 * 1000;
        const altZoned = getZonedParts(alt, tz);
        const altWall: WallClock = {
          year: altZoned.year,
          month: altZoned.month,
          day: altZoned.day,
          hour: altZoned.hour,
          minute: altZoned.minute,
          second: altZoned.second,
        };
        if (
          alt > afterMs &&
          altWall.year === desiredParts.year &&
          altWall.month === desiredParts.month &&
          altWall.day === desiredParts.day &&
          altWall.hour === desiredParts.hour &&
          altWall.minute === desiredParts.minute
        ) {
          utcMs = alt;
          break;
        }
      }
    }

    if (utcMs <= afterMs) {
      cursor = addWallClockMinutes(candidate, 1);
      continue;
    }

    return utcMs;
  }

  throw new Error("No next run found within search horizon");
}

