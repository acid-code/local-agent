export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  severity: Severity;
  code: string;
  detail: string;
  weight?: number;
}

const WEIGHT: Record<Severity, number> = {
  info: 2,
  low: 8,
  medium: 15,
  high: 25,
  critical: 40,
};

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export function scoreRisk(findings: Finding[]): { score: number; level: RiskLevel } {
  const score = Math.max(0, Math.min(100, findings.reduce((sum, finding) => sum + (finding.weight ?? WEIGHT[finding.severity]), 0)));
  const level: RiskLevel = score >= 71 ? 'critical' : score >= 46 ? 'high' : score >= 21 ? 'medium' : 'low';
  return { score, level };
}
