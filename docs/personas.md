# Personas

Each shipped persona has a versioned contract in `personas/<slug>/contract.json`. The system prompt, tool list, and approval list in the app are loaded from that file. A handoff, trigger event, or tool call that does not match is repaired once and then failed in the run timeline.

| Persona | Purpose | Inputs | Outputs | Tools | Needs approval | Auto role |
| --- | --- | --- | --- | --- | --- | --- |
| House operator (`general`) | Run the box and hand real code changes to the coder | chat, handoff, trigger | reply, handoff, activity, notification | files, shell, memory, docker list/inspect | write file, destructive shell, docker run/remove | main |
| Coder (`coder`) | Implement a plan in a shared repo or workshop | chat, plan, handoff | reply, patch, activity | search, patch, git, shell, plan | git push, pull, revert, force-push, folder grant, CLI handoff | coder |
| Planner (`planner`) | Search and write a plan. Does not edit or push | chat, trigger | plan, reply, handoff | web search, fetch, read, plan, consult, repo sync | repo sync | thinking |
| Researcher (`researcher`) | Search before stating a current fact | chat, handoff | reply, notification | web search, fetch, read, memory, consult | none | main |
| Voice (`voice`) | Short reply from a transcript | transcript | reply | none | none | fast |
| Auto (`router`) | Pick fast, main, coder, thinking, or cloud | chat | route | none | none | fast |
| Trigger run (`trigger`) | Start from a webhook, GitHub, folder, or mailbox event | trigger | reply, activity, notification | the target persona's tools | the target persona's approvals | main |

Auto starts on main. A summary or a very short line uses fast. A code change uses coder. "Think harder", two failed attempts, or a context that does not fit uses thinking. `/smart` or "use the smart model" uses cloud, and the existing Gemini quota rules still apply.

Coder never pushes, force-pushes, pulls, or reverts unless that action was approved. The contract test locks that in.
