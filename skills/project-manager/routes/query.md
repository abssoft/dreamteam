# Запрос — a key with free text and no mode token

Loaded when the invocation names a key and carries free text without a mode token. Read the intent from the text against the §3 resolution (`"self": true`, `"attachments": true`, no `mark`) and pick exactly one outcome:

- the text plainly asks for the product document («напиши ПР», «нужно ТЗ») → run `PRD` as if its token were given, the text riding in as boundaries; development and delivery are never inferred — their tokens are the only entry (Run model);
- the text is a question about the item, or a bounded tracker action the adapter covers (what the task, its comments or subtasks say; a comment the user dictated) → answer it from the resolution's files and `comment`: reads freely, one `comment` call per explicitly dictated comment (its text written to `<run_dir>/comment.md`, `"required": true`), no stage move, no Git, no role launch; a tracker action the adapter has no operation for (a tag, a field, a knowledge-base lookup) belongs to the dispatcher's own modes — name the dispatcher's mode in one line when the manifest lists one, else say the action is outside the process; then stop;
- anything else — two readings that lead to different work, or a request the item does not ground (a check output the chat never showed, a file the resolution does not carry) → one line «Поставь конкретную задачу: …» naming what is missing or the two or three commands you would run, then stop. Never guess a mode.

The answer is the terminal report of its run; the §13 narration cap does not apply to its body, and no Follow-up block is emitted. End with the whole-session «Затрачено» call like any run without launches.
