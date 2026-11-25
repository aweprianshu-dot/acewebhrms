import type { EmployeeProfile } from '../types/hrms';

export interface OrgChartHierarchy {
  byUid: Map<string, EmployeeProfile>;
  children: Map<string, EmployeeProfile[]>;
  roots: EmployeeProfile[];
  orphaned: EmployeeProfile[];
}

export function getOrgNodeKey(employee: Pick<EmployeeProfile, 'id' | 'uid'>): string {
  return employee.uid || employee.id;
}

export function partitionOrgChartHierarchy(employees: EmployeeProfile[]): OrgChartHierarchy {
  const byUid = new Map<string, EmployeeProfile>();
  for (const emp of employees) {
    if (emp.uid) byUid.set(emp.uid, emp);
  }

  const children = new Map<string, EmployeeProfile[]>();
  for (const emp of employees) {
    if (emp.reportingManagerUid && emp.reportingManagerUid !== emp.uid && byUid.has(emp.reportingManagerUid)) {
      const list = children.get(emp.reportingManagerUid) || [];
      list.push(emp);
      children.set(emp.reportingManagerUid, list);
    }
  }

  const roots = employees.filter(
    (e) =>
      !e.reportingManagerUid ||
      e.reportingManagerUid === e.uid ||
      !byUid.has(e.reportingManagerUid),
  );

  // Traverse reachable descendants from all roots so subordinates are never duplicated as orphans
  const reachable = new Set<string>();
  const queue: EmployeeProfile[] = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = getOrgNodeKey(current);
    if (reachable.has(key)) continue;
    reachable.add(key);
    if (current.uid) {
      for (const child of children.get(current.uid) || []) {
        if (!reachable.has(getOrgNodeKey(child))) {
          queue.push(child);
        }
      }
    }
  }

  // Only nodes unreachable from any root (i.e. pure reporting cycles) remain as orphan roots;
  // break pure cycles once per connected component so members of a cycle aren't duplicated as multiple roots.
  const orphaned: EmployeeProfile[] = [];
  for (const emp of employees) {
    const key = getOrgNodeKey(emp);
    if (reachable.has(key)) continue;
    orphaned.push(emp);
    const cycleQueue: EmployeeProfile[] = [emp];
    while (cycleQueue.length > 0) {
      const curr = cycleQueue.shift()!;
      const currKey = getOrgNodeKey(curr);
      if (reachable.has(currKey)) continue;
      reachable.add(currKey);
      if (curr.uid) {
        for (const child of children.get(curr.uid) || []) {
          if (!reachable.has(getOrgNodeKey(child))) {
            cycleQueue.push(child);
          }
        }
      }
    }
  }

  return { byUid, children, roots, orphaned };
}
