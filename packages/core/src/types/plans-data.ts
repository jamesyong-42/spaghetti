/**
 * TypeScript interfaces for ~/.claude/plans/
 */

export interface PlanFile {
  slug: string;
  title: string;
  content: string;
  size: number;
}

export interface PlansDirectory {
  plans: PlanFile[];
}
