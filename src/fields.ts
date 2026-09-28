/**
 * Shared field vocabulary for the resolve form.
 *
 * Lives in its own module because both the read layer (`zentao.ts`) and the
 * planner (`resolve.ts`) need it, and a value-level import between those two
 * would create a cycle.
 *
 * Provenance: these rules were validated against this instance by
 * `dsh-fetch-page`'s `zentao_resolve_bug` — the server rejects a violation with
 * HTTP 200 plus an `alert()`, so they must be enforced locally, before the POST.
 */

export interface ResolveFieldRule {
  name: string
  label: string
  max?: number
  required?: boolean
}

export const RESOLVE_FIELD_RULES: ResolveFieldRule[] = [
  { name: 'resolution', label: '解决方案', required: true },
  { name: 'reason', label: 'Bug产生原因', required: true },
  { name: 'bugInchargedBy', label: 'Bug所属人', required: true },
  { name: 'changeImpact', label: '代码变更影响范围', required: true },
  { name: 'detail_reason', label: 'bug详细原因', max: 512 },
  { name: 'comment', label: '备注' },
]

export const FIELD_LABELS = new Map(RESOLVE_FIELD_RULES.map((rule) => [rule.name, rule.label]))
