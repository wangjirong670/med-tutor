import type { ScheduledTaskRecord, ScheduledTaskSchedule } from "../../contracts/desktop-state";
import type { Weekday } from "../../contracts/scheduled-tasks";
import type { RecencyBucketId } from "../../contracts/thread-recency";
import type { AppLocale, MessageKey } from "./catalog";
import type { Translate } from "./translate";

/**
 * Formats a relative time string such as "刚刚" / "5 分钟前" using the active catalog.
 */
export function formatRelativeTimeLocalized(value: string, t: Translate): string {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return t("threads.relative.now");
  if (diffMinutes < 60) return t("threads.relative.minutes", { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("threads.relative.hours", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return t("threads.relative.days", { count: diffDays });
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return t("threads.relative.weeks", { count: diffWeeks });
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return t("threads.relative.months", { count: diffMonths });
  const diffYears = Math.floor(diffDays / 365);
  return t("threads.relative.years", { count: diffYears });
}

const RECENCY_KEY_BY_BUCKET: Readonly<Record<RecencyBucketId, MessageKey>> = {
  today: "threads.recency.today",
  "last-7-days": "threads.recency.last7Days",
  "last-30-days": "threads.recency.last30Days",
  older: "threads.recency.older",
};

export function formatRecencyBucketLabel(bucket: RecencyBucketId, t: Translate): string {
  return t(RECENCY_KEY_BY_BUCKET[bucket]);
}

const WEEKDAY_KEY_BY_INDEX: Readonly<Record<Weekday, MessageKey>> = {
  0: "scheduled.weekday.0",
  1: "scheduled.weekday.1",
  2: "scheduled.weekday.2",
  3: "scheduled.weekday.3",
  4: "scheduled.weekday.4",
  5: "scheduled.weekday.5",
  6: "scheduled.weekday.6",
};

export function formatWeekdayShortLocalized(day: Weekday, t: Translate): string {
  return t(WEEKDAY_KEY_BY_INDEX[day]);
}

function formatClockLocalized(hour: number, minute: number, locale: AppLocale): string {
  if (locale.startsWith("zh")) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function joinLocalizedNames(names: readonly string[], locale: AppLocale): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (locale.startsWith("zh")) {
    return names.join("、");
  }
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function formatScheduledTaskRecurrenceLocalized(
  schedule: ScheduledTaskSchedule,
  t: Translate,
  locale: AppLocale,
): string {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) {
      return t("scheduled.meta.once");
    }
    const formatted = new Date(at).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return t("scheduled.meta.onceAt", { time: formatted });
  }
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % (24 * 60) === 0) {
      return t("scheduled.meta.everyDays", { count: minutes / (24 * 60) });
    }
    if (minutes % 60 === 0) {
      return t("scheduled.meta.everyHours", { count: minutes / 60 });
    }
    return t("scheduled.meta.everyMinutes", { count: minutes });
  }
  const time = formatClockLocalized(schedule.hour, schedule.minute, locale);
  if (schedule.kind === "daily") {
    return t("scheduled.meta.dailyAt", { time });
  }
  const names = [...schedule.days]
    .sort((left, right) => left - right)
    .map((day) => formatWeekdayShortLocalized(day, t));
  return t("scheduled.meta.weeklyAt", { days: joinLocalizedNames(names, locale), time });
}

export function formatScheduledTaskNextRunLocalized(
  nextRunAt: string,
  t: Translate,
  now = new Date(),
): string {
  const timestamp = Date.parse(nextRunAt);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffMs = timestamp - now.getTime();
  if (diffMs <= 0) {
    return t("scheduled.meta.dueNow");
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return t("scheduled.meta.nextUnderMinute");
  }
  if (diffMinutes < 60) {
    return t("scheduled.meta.nextMinutes", { count: diffMinutes });
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t("scheduled.meta.nextHours", { count: diffHours });
  }
  const diffDays = Math.floor(diffHours / 24);
  return t("scheduled.meta.nextDays", { count: diffDays });
}

export function formatScheduledTaskRowMetaLocalized(
  task: ScheduledTaskRecord,
  t: Translate,
  locale: AppLocale,
  now = new Date(),
): string {
  const recurrence = formatScheduledTaskRecurrenceLocalized(task.schedule, t, locale);
  if (task.status === "completed") {
    return recurrence;
  }
  if (task.status === "paused") {
    return t("scheduled.meta.paused", { recurrence });
  }
  if (!task.nextRunAt) {
    return recurrence;
  }
  return `${recurrence} · ${formatScheduledTaskNextRunLocalized(task.nextRunAt, t, now)}`;
}
