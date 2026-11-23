import type { ScheduledTaskRecord } from "../../../contracts/desktop-state";
import { formatScheduledTaskRowMetaLocalized, useTranslation } from "../../i18n";

interface ScheduledTaskChipProps {
  readonly task: ScheduledTaskRecord;
  readonly onOpen: () => void;
}

export function ScheduledTaskChip({ task, onOpen }: ScheduledTaskChipProps) {
  const { t, locale } = useTranslation();
  return (
    <div className="scheduled-task-chip" data-testid="scheduled-task-chip">
      <span>{formatScheduledTaskRowMetaLocalized(task, t, locale)}</span>
      <button className="button button--secondary" type="button" onClick={onOpen}>
        {t("scheduled.chip.open")}
      </button>
    </div>
  );
}
