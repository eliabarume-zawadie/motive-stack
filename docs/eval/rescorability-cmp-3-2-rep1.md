# Can the existing results be rescored?

A result can be rescored only if the model's output text was saved. These reports hold scores and check details, not output text.

| Report | Scored by | Cases | Output text saved | Rescorable | Why |
|---|---|---|---|---|---|
| `docs/eval/cmp-3-2-original-rep1-openai-gpt_6_luna.json` | campaign-evaluator/3.2.0 | 14 | **no** | **no** | the model's output text was never persisted (the report holds scores and check details only), so it cannot be rescored. It is not regenerated or reconstructed, because that would be a different result. |
| `docs/eval/cmp-3-2-current-rep1-openai-gpt_6_luna.json` | campaign-evaluator/3.2.0 | 14 | **no** | **no** | the model's output text was never persisted (the report holds scores and check details only), so it cannot be rescored. It is not regenerated or reconstructed, because that would be a different result. |

