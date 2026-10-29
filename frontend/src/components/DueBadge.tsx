export function DueBadge({ label, urgent }: { label: string; urgent: boolean }) {
  if (!label) return null
  return <span className={urgent ? 'due-badge due-badge--urgent' : 'due-badge'}>{label}</span>
}
