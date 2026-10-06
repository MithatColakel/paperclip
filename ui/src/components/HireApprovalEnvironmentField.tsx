import { EnvironmentSelect } from "./EnvironmentSelect";
import { useEnvironmentChoices } from "../hooks/useEnvironmentChoices";
import {
  hasRemoteEnvironmentChoice,
  inheritedEnvironmentLabel,
  resolveInheritedEnvironment,
} from "../lib/environment-defaults";

/**
 * Lets the approver of a hire decide where the new agent runs. The requested
 * environment (if any) is preselected; approving sends the final choice.
 */
export function HireApprovalEnvironmentField({
  companyId,
  adapterType,
  value,
  onChange,
  disabled,
}: {
  companyId: string;
  adapterType: string | null;
  value: string | null;
  onChange: (environmentId: string | null) => void;
  disabled?: boolean;
}) {
  const choices = useEnvironmentChoices(companyId);
  if (!choices.ready) return null;
  if (!hasRemoteEnvironmentChoice(choices.environments, adapterType) && !value) return null;
  return (
    <div className="space-y-1.5">
      <label htmlFor="hire-approval-environment" className="text-xs text-muted-foreground">
        Where will this agent run?
      </label>
      <EnvironmentSelect
        id="hire-approval-environment"
        aria-label="Hired agent environment"
        environments={choices.environments}
        adapterType={adapterType}
        value={value}
        onChange={onChange}
        disabled={disabled}
        inheritLabel={inheritedEnvironmentLabel(
          resolveInheritedEnvironment({
            environments: choices.environments,
            companyDefaultEnvironmentId: choices.companyDefaultEnvironmentId,
            instanceDefaultEnvironmentId: choices.instanceDefaultEnvironmentId,
            adapterType,
          }),
        )}
      />
    </div>
  );
}
