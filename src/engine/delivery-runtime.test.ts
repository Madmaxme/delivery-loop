import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ghaDispatchFields,
  planDeliveryInvocation,
} from "./delivery-runtime.ts";

describe("planDeliveryInvocation", () => {
  it("defaults sweep to GHA outside Actions so chat VMs are not the parent", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "sweep",
      argv: ["--project", "Payments"],
    });
    assert.equal(plan.runtime, "gha");
    assert.equal(plan.project, "Payments");
    assert.deepEqual(ghaDispatchFields(plan), {
      mode: "sweep",
      project: "Payments",
    });
  });

  it("defaults ground/build/land to local so they cannot cancel a live sweep", () => {
    for (const mode of ["ground", "build", "land"] as const) {
      const plan = planDeliveryInvocation({
        githubActions: false,
        mode,
        argv: ["APP-1"],
      });
      assert.equal(plan.runtime, "local", mode);
    }
  });

  it("defaults pipeline to GHA like sweep", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "pipeline",
      argv: ["APP-713"],
    });
    assert.equal(plan.runtime, "gha");
  });

  it("stays local inside GitHub Actions even if env asks for gha", () => {
    const plan = planDeliveryInvocation({
      githubActions: true,
      envRuntime: "gha",
      mode: "sweep",
      argv: ["--runtime=gha", "--project", "Payments"],
    });
    assert.equal(plan.runtime, "local");
    assert.match(plan.reason, /already inside GitHub Actions/);
  });

  it("honors --local for debug on a laptop or cloud VM", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "pipeline",
      argv: ["--local", "APP-713"],
    });
    assert.equal(plan.runtime, "local");
    assert.equal(plan.issue, "APP-713");
    assert.deepEqual(plan.localArgs, ["--issue", "APP-713"]);
  });

  it("rebuilds sweep localArgs from --project so --local still works", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "sweep",
      argv: ["--local", "--project", "Payments"],
    });
    assert.equal(plan.runtime, "local");
    assert.deepEqual(plan.localArgs, ["--project", "Payments"]);
  });

  it("honors DELIVERY_LOOP_RUNTIME=local", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      envRuntime: "local",
      mode: "sweep",
      argv: [],
    });
    assert.equal(plan.runtime, "local");
  });

  it("maps --no-fill-graph and --surface onto GHA fields", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "sweep",
      argv: ["--surface", "api,web", "--no-fill-graph"],
    });
    assert.deepEqual(ghaDispatchFields(plan), {
      mode: "sweep",
      surface: "api,web",
      no_fill_graph: "true",
    });
  });

  it("maps --fill-graph onto GHA fields", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "sweep",
      argv: ["--project", "Payments", "--fill-graph"],
    });
    assert.equal(plan.fillGraph, true);
    assert.deepEqual(ghaDispatchFields(plan), {
      mode: "sweep",
      project: "Payments",
      fill_graph: "true",
    });
  });

  it("accepts --runtime=local as a flag", () => {
    const plan = planDeliveryInvocation({
      githubActions: false,
      mode: "ground",
      argv: ["--runtime", "local", "--issue", "app-1"],
    });
    assert.equal(plan.runtime, "local");
    assert.equal(plan.issue, "APP-1");
  });
});
