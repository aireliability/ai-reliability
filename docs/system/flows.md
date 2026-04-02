# Flows

## What is a run
A **run** is one evaluation execution (`EvalRun`) over a dataset (or subset) that processes samples and produces persisted `SampleResult`/summary outputs. Its progress is tracked by `RunStatus`, with an optional `finalStatus` once completed.

## What is a sample
A **sample** is one `DatasetSample` within a dataset. During evaluation it yields one `SampleResult`, including `output`, `rules`, `classification`, and `passed`/`errorType` when applicable.

## What is a failure
A **failure** occurs when `SampleResult.classification !== "PASS"`. Supporting details such as `errorType` may explain why it failed, but classification is the source of truth.

## What is a dataset
A **dataset** is an `EvalDataset` (id/name/version) containing a list of `DatasetSample` items that runs use as their input.

## Run lifecycle

- `PENDING`: created and waiting to start
- `RUNNING`: actively processing samples
- `COMPLETED`: evaluation finished successfully (no unhandled errors)
- `FAILED`: evaluation ended due to a run-level failure
- `STOPPED`: evaluation was halted before completion

## Sample evaluation flow

- sample loaded
- output generated
- rules checked
- classification assigned
- result written
