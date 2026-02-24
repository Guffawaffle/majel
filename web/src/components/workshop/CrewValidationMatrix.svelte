<script lang="ts">
  import type { CrewValidation } from "../../lib/crew-validator.js";
  import type { EvaluationIssue, EvaluationStatus } from "../../lib/types/effect-types.js";

  interface MatrixCell {
    status: EvaluationStatus | "none";
    issues: EvaluationIssue[];
  }

  interface MatrixRow {
    effectKey: string;
    cells: MatrixCell[];
  }

  interface Props {
    validation: CrewValidation | null;
  }

  const { validation }: Props = $props();
  let expandedCellKey = $state<string | null>(null);

  const STATUS_PRIORITY: Record<MatrixCell["status"], number> = {
    blocked: 3,
    conditional: 2,
    works: 1,
    none: 0,
  };

  const STATUS_ICON: Record<MatrixCell["status"], string> = {
    works: "✅",
    conditional: "⚠️",
    blocked: "❌",
    none: "—",
  };

  function humanizeEffectKey(effectKey: string): string {
    return effectKey.replace(/_/g, " ");
  }

  function compareStatus(a: MatrixCell["status"], b: MatrixCell["status"]): MatrixCell["status"] {
    return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
  }

  function dedupeIssues(issues: EvaluationIssue[]): EvaluationIssue[] {
    const seen = new Set<string>();
    const output: EvaluationIssue[] = [];
    for (const issue of issues) {
      const key = `${issue.type}:${issue.message}:${issue.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(issue);
    }
    return output;
  }

  const rows = $derived.by((): MatrixRow[] => {
    if (!validation || validation.officers.length === 0) return [];

    const rowMap = new Map<string, MatrixRow>();
    const officerCount = validation.officers.length;

    for (let officerIndex = 0; officerIndex < validation.officers.length; officerIndex += 1) {
      const officer = validation.officers[officerIndex]!;
      for (const abilityEval of officer.evaluation.abilities) {
        for (const effectEval of abilityEval.effects) {
          const key = effectEval.effectKey;
          const existing = rowMap.get(key) ?? {
            effectKey: key,
            cells: Array.from({ length: officerCount }, () => ({ status: "none", issues: [] } as MatrixCell)),
          };

          const prevCell = existing.cells[officerIndex] ?? { status: "none", issues: [] };
          existing.cells[officerIndex] = {
            status: compareStatus(prevCell.status, effectEval.status),
            issues: dedupeIssues([...prevCell.issues, ...effectEval.issues]),
          };

          rowMap.set(key, existing);
        }
      }
    }

    return [...rowMap.values()].sort((a, b) => a.effectKey.localeCompare(b.effectKey));
  });

  function cellTitle(cell: MatrixCell): string {
    if (cell.issues.length === 0) return "No issues";
    return cell.issues.map((issue) => issue.message).join("; ");
  }

  function toggleCell(effectKey: string, officerIndex: number): void {
    const key = `${effectKey}:${officerIndex}`;
    expandedCellKey = expandedCellKey === key ? null : key;
  }
</script>

{#if validation && validation.officers.length > 0}
  <section class="qc-validation" aria-label="Crew validation matrix">
    <h5>Does it work? Validation Matrix</h5>
    <table class="qc-validation-table">
      <thead>
        <tr>
          <th scope="col">Effect</th>
          {#each validation.officers as officer}
            <th scope="col">{officer.officerName}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if rows.length === 0}
          <tr>
            <td colspan={validation.officers.length + 1}>No evaluable effects for selected crew/context.</td>
          </tr>
        {:else}
          {#each rows as row}
            <tr>
              <th scope="row">{humanizeEffectKey(row.effectKey)}</th>
              {#each row.cells as cell, officerIndex}
                <td>
                  <button
                    type="button"
                    class="qc-cell"
                    class:qc-cell-works={cell.status === "works"}
                    class:qc-cell-conditional={cell.status === "conditional"}
                    class:qc-cell-blocked={cell.status === "blocked"}
                    title={cellTitle(cell)}
                    onclick={() => toggleCell(row.effectKey, officerIndex)}
                    aria-label={`${humanizeEffectKey(row.effectKey)} for ${validation.officers[officerIndex]?.officerName ?? "officer"}: ${cell.status}`}
                  >
                    {STATUS_ICON[cell.status]}
                  </button>
                  {#if expandedCellKey === `${row.effectKey}:${officerIndex}` && cell.issues.length > 0}
                    <div class="qc-cell-detail" role="note">
                      {#each cell.issues as issue}
                        <p>{issue.message}</p>
                      {/each}
                    </div>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        {/if}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Crew fitness</th>
          <td colspan={validation.officers.length}>
            {validation.totalScore} · {validation.verdict}
          </td>
        </tr>
      </tfoot>
    </table>
    {#if validation.summary.length > 0}
      <ul class="qc-validation-summary">
        {#each validation.summary as line}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .qc-validation {
    margin-top: 1rem;
    border: 1px solid var(--ws-border, #2a3a4a);
    border-radius: 10px;
    padding: 0.75rem;
  }

  .qc-validation-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0.5rem;
  }

  .qc-validation-table th,
  .qc-validation-table td {
    border: 1px solid var(--ws-border, #2a3a4a);
    padding: 0.35rem 0.45rem;
    text-align: center;
    vertical-align: top;
  }

  .qc-validation-table th[scope="row"] {
    text-align: left;
    white-space: nowrap;
  }

  .qc-cell {
    background: transparent;
    border: 0;
    cursor: pointer;
    font-size: 1rem;
  }

  .qc-cell-detail {
    margin-top: 0.25rem;
    text-align: left;
    font-size: 0.8rem;
  }

  .qc-cell-detail p {
    margin: 0.15rem 0;
  }

  .qc-validation-summary {
    margin: 0.6rem 0 0;
    padding-left: 1rem;
    font-size: 0.9rem;
  }
</style>