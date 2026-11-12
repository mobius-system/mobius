# Cross-Session Search: Find Content Across All Sessions

‍

As sessions pile up, use the top-bar **global search** to look across the full content of every session at once — including historical sessions you've already closed.

## How to

1. Click the **Search** button in the top bar (just left of `+ New`).

    ![image](https://serve.nutshellai.cn/publish/auto/tutorial/25_search_01.jpg)

2. Type a keyword (at least 2 characters; it searches automatically when you pause, or press Enter).

    ![image](https://serve.nutshellai.cn/publish/auto/tutorial/25_search_02.jpg)

3. Click any result to jump straight into that session's chat.

## Reading the results

Each card shows the match's **hierarchy**, left to right:

- **Project › Issue / Research › Session** — which project, task, and session the text lives in.
- Below is the **matched fragment** with the keyword **highlighted in yellow**; the role (user / assistant / tool) is tagged on the left.
- The top-right shows the session's **last-active time**.

## Notes

- Search uses the full-text index in Mobius's history store and filters by session activity range by default. Multiple terms must match the same message.
- The index is built and updated in the background; the UI reports history that is not indexed instead of treating it as no result.
- You can **only find sessions you're allowed to read** — your own, or sessions in projects visible to you.
