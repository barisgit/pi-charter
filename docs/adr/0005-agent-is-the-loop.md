# The agent is the loop, not an auto-spawn scheduler

Status: accepted

pi-charter follows the smart-Ralph pattern: the root agent reads charter status, drift views, and evaluator steer each turn, then chooses one next move. The extension may provide advisory `readyNext` views and internal verifier/planner/evaluator personas, but it does not auto-schedule worker subagents or maintain a worker pool; this keeps orchestration in the main session where user intent and context already live.
