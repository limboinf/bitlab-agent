import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const root = join(import.meta.dir, "..");
const source = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const workflow = yaml.load(source) as {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs?: Record<string, { if?: string; needs?: string | string[]; steps?: unknown[] }>;
};

describe("optimized release workflow", () => {
  it("builds candidates manually and promotes tags without rebuilding", () => {
    const jobs = workflow.jobs ?? {};

    expect(jobs.build?.if).toContain("workflow_dispatch");
    expect(jobs.candidate?.if).toContain("workflow_dispatch");
    expect(jobs.promote?.if).toContain("push");
    expect(jobs.promote?.needs).toBe("preflight");
    expect(source).toContain("release-candidate-${{ inputs.tag || github.ref_name }}-${{ github.sha }}");
    expect(source).toContain("actions/download-artifact@v4");
    expect(source).toContain("run-id: ${{ steps.candidate.outputs.run_id }}");
  });

  it("runs verification and platform builds in parallel after preflight", () => {
    const jobs = workflow.jobs ?? {};

    expect(jobs.verify?.needs).toBe("preflight");
    expect(jobs.build?.needs).toEqual(["preflight", "release-policy"]);
    expect(jobs.candidate?.needs).toEqual(["verify", "build", "release-policy"]);
  });

  it("does not keep the old direct-publish input or tag rebuild path", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};

    expect(inputs).not.toHaveProperty("dry_run");
    expect(source).not.toContain("inputs.dry_run");
    expect(source).not.toContain("needs: [verify, release-policy]");
  });

  it("binds promotion to exact workflow, run, commit, and checksums", () => {
    expect(source).toContain("actions/workflows/release.yml");
    expect(source).toContain('.workflow_id == $workflow_id');
    expect(source).toContain('.event == "workflow_dispatch"');
    expect(source).toContain('"${{ steps.candidate.outputs.run_id }}"');
    expect(source).toContain("release-candidate.ts verify");
  });
});
