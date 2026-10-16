import type {
  CompanyExecutionDevicesResponse,
  ExecutionDeviceCheckNowResponse,
  ExecutionDeviceDetail,
  ExecutionWaitSettings,
  InstanceExecutionDeviceSummary,
  InstanceExecutionDevicesResponse,
  LinkDeviceTarget,
  UpdateExecutionDevice,
  UpdateExecutionWaitSettings,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Fork: query keys for execution devices and wait settings. They live here so
 * the upstream `queryKeys.ts` stays untouched; every key starts with
 * `executionDeviceKeys.all`, so one invalidation covers them all.
 */
export const executionDeviceKeys = {
  all: ["execution-devices"] as const,
  company: (companyId: string) => ["execution-devices", "company", companyId] as const,
  detail: (companyId: string, deviceId: string) => ["execution-devices", "company", companyId, "device", deviceId] as const,
  waitSettings: (companyId: string) => ["execution-devices", "company", companyId, "wait-settings"] as const,
  instance: ["execution-devices", "instance"] as const,
};

const segment = encodeURIComponent;

/** Fork: execution devices as one company sees them, wait settings, and the instance admin device routes. */
export const executionDevicesApi = {
  list: (companyId: string) =>
    api.get<CompanyExecutionDevicesResponse>(`/companies/${segment(companyId)}/devices`),
  get: (companyId: string, deviceId: string) =>
    api.get<ExecutionDeviceDetail>(`/companies/${segment(companyId)}/devices/${segment(deviceId)}`),
  /** Forced availability check in this company's context, then a wake. 404 when the device is not visible, 429 within a minute. */
  checkNow: (companyId: string, deviceId: string) =>
    api.post<ExecutionDeviceCheckNowResponse>(`/companies/${segment(companyId)}/devices/${segment(deviceId)}/check-now`, {}),
  getWaitSettings: (companyId: string) =>
    api.get<ExecutionWaitSettings>(`/companies/${segment(companyId)}/execution-wait-settings`),
  /** Company admins only. */
  updateWaitSettings: (companyId: string, input: UpdateExecutionWaitSettings) =>
    api.put<ExecutionWaitSettings>(`/companies/${segment(companyId)}/execution-wait-settings`, input),
  /** Instance admins only, as are the two routes below. */
  listInstance: () => api.get<InstanceExecutionDevicesResponse>("/instance/devices"),
  /** 409 when `maxAccounts` drops below the accounts already bound there. */
  updateInstance: (deviceId: string, input: UpdateExecutionDevice) =>
    api.patch<InstanceExecutionDeviceSummary>(`/instance/devices/${segment(deviceId)}`, input),
  /** Links a device to a plugin-reported target: one machine reached two ways. */
  linkTarget: (deviceId: string, input: LinkDeviceTarget) =>
    api.post<InstanceExecutionDeviceSummary>(`/instance/devices/${segment(deviceId)}/link-target`, input),
};
