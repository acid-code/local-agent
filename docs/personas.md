# Personas

Each shipped persona has a versioned contract in `personas/<slug>/contract.json`. The system prompt, tool list, and approval list in the app are loaded from that file. A handoff, trigger event, or tool call that does not match is repaired once and then failed in the run timeline.

| Persona | Purpose | Inputs | Outputs | Tools | Needs approval | Auto role | Context |
| --- | --- | --- | --- | --- | --- | --- | --- |
| House operator (`general`) | Run the box and hand real code changes to the coder | chat, handoff, trigger | reply, handoff, activity, notification | files, shell, memory, docker list/inspect | write file, destructive shell, docker run/remove | main | rolling |
| Coder (`coder`) | Implement a plan in a shared repo or workshop | chat, plan, handoff | reply, patch, activity | search, patch, git, shell, plan | git push, pull, revert, force-push, folder grant, CLI handoff | coder | hierarchical plus retrieval |
| Planner (`planner`) | Search and write a plan. Does not edit or push | chat, trigger | plan, reply, handoff | web search, fetch, read, plan, consult, repo sync | repo sync | thinking | hierarchical plus retrieval |
| Researcher (`researcher`) | Search before stating a current fact | chat, handoff | reply, notification | web search, fetch, read, memory, consult | none | main | retrieval |
| Voice (`voice`) | Short reply from a transcript | transcript | reply | none | none | fast | rolling |
| Auto (`router`) | Pick fast, main, coder, thinking, or cloud | chat | route | none | none | fast | pinned |
| Trigger run (`trigger`) | Start from a webhook, GitHub, folder, or mailbox event | trigger | reply, activity, notification | the target persona's tools | the target persona's approvals | main | pinned |

Auto starts on main. The LAN setup page maps each role to a model. Defaults are fast `qwen3:4b`, coder `qwen3-coder:30b`, embed `nomic-embed-text`, main Gemma 4 26B-A4B if it is installed otherwise Qwen3.6 35B-A3B, thinking that main model with reasoning on, and cloud Gemini when the free quota is open. A short reply uses fast. A code change uses coder. "Think harder", two failed attempts, or a context that does not fit climbs one step (fast, then main, then thinking, then cloud). `/smart` or "use the smart model" uses the cloud role. The next ordinary message goes back to main. `/model <name>` or the model pill pins a model. `/auto` clears the pin. One large local model is loaded at a time. Ollama is asked for `num_ctx` equal to that model's practical budget.

Coder never pushes, force-pushes, pulls, or reverts unless that action was approved. The contract test locks that in.
