export type PlanStatus = 'draft' | 'pending_approval' | 'running' | 'paused_at_checkpoint' | 'completed' | 'failed' | 'cancelled';
export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval';
export type PlanStepRisk = 'auto' | 'checkpoint' | 'proactive';
export type PlanTrigger = 'reasoning' | 'user' | 'event';

export interface PlanStep {
  index: number;
  description: string;
  skillName: string;
  skillParams: Record<string, unknown>;
  riskLevel: PlanStepRisk;
  status: PlanStepStatus;
  result?: Record<string, unknown>;
  error?: string;
  condition?: string;
  onFailure: 'stop' | 'skip' | 'retry' | 'replan';
  dependsOn?: number[];
}

export interface Plan {
  id: string;
  userId: string;
  goal: string;
  status: PlanStatus;
  steps: PlanStep[];
  currentStepIndex: number;
  context: Record<string, unknown>;
  triggerSource: PlanTrigger;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
