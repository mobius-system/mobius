#!/usr/bin/env python3
"""Render a Mobius self-evolution demo with typewriter transition title cards."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


WIDTH = 1440
HEIGHT = 900
FPS = 25
INTRO_SECONDS = 5.6
TRANSITION_1_SECONDS = 3.0
TRANSITION_2_SECONDS = 3.8
TRIM_START_SECONDS = 2.0
DEFAULT_INTRO = "让我们来尝试...........<把这里替换成用户命令的概括>...........|首先我们看一下自我迭代之前的样子。"
DEFAULT_TRANSITION_1 = "接下来，我们给小莫提出需求，提出需求"
DEFAULT_TRANSITION_2 = "小莫会处理您的指令……|等待享用一杯咖啡的时间后……"
TYPE_SECONDS_PER_CHAR = 0.075
CURSOR_SECONDS = 0.32


def run(cmd: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        raise SystemExit(
            "Command failed:\n"
            + " ".join(cmd)
            + ("\n\nstdout:\n" + stdout if stdout else "")
            + ("\n\nstderr:\n" + stderr if stderr else "")
        )
    return result


def ass_time(seconds: float) -> str:
    total_centis = int(round(seconds * 100))
    hours, rem = divmod(total_centis, 3600 * 100)
    minutes, rem = divmod(rem, 60 * 100)
    secs, centis = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def join_ass_lines(lines: list[str]) -> str:
    return r"\N".join(ass_escape(line) for line in lines)


def typewriter_states(lines: list[str], duration: float) -> list[tuple[float, float, list[str]]]:
    if not lines:
        lines = [""]
    states: list[tuple[float, float, list[str]]] = []
    current = min(0.28, duration)
    visible = [""] * len(lines)

    def add_state(start: float, end: float, text_lines: list[str]) -> None:
        if end > start:
            states.append((start, end, text_lines.copy()))

    add_state(0, current, visible)

    for line_index, line in enumerate(lines):
        for char_index in range(1, len(line) + 1):
            next_time = min(current + TYPE_SECONDS_PER_CHAR, duration - 0.28)
            visible[line_index] = line[:char_index]
            cursor_lines = visible.copy()
            cursor_lines[line_index] += "|"
            add_state(current, max(next_time, current + 0.04), cursor_lines)
            current = next_time
        if line_index < len(lines) - 1:
            pause_end = min(current + 0.22, duration - 0.28)
            cursor_lines = visible.copy()
            cursor_lines[line_index] += "|"
            add_state(current, pause_end, cursor_lines)
            current = pause_end

    if not states:
        states.append((0, duration, visible))

    final_text = lines.copy()
    while current < duration - 0.24:
        cursor_on_end = min(current + CURSOR_SECONDS, duration - 0.24)
        add_state(current, cursor_on_end, [*final_text[:-1], final_text[-1] + "|"])
        current = cursor_on_end
        cursor_off_end = min(current + CURSOR_SECONDS, duration - 0.24)
        add_state(current, cursor_off_end, final_text)
        current = cursor_off_end

    add_state(max(duration - 0.24, 0), duration, final_text)
    return [(start, end, text) for start, end, text in states if end > start]


def write_ass(path: Path, lines: list[str], duration: float) -> None:
    body = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Noto Sans CJK SC,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,90,90,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    for start, end, text_lines in typewriter_states(lines, duration):
        body += (
            "Dialogue: 0,"
            f"{ass_time(start)},{ass_time(end)},Title,,0,0,0,,"
            f"{join_ass_lines(text_lines)}\n"
        )
    path.write_text(body, encoding="utf-8")


def render_transition(ass_path: Path, output: Path, duration: float) -> None:
    source = f"color=c=black:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration}"
    video_filter = (
        f"format=yuv420p,ass=filename={ass_path},"
        "fade=t=in:st=0:d=0.16,"
        f"fade=t=out:st={max(duration - 0.20, 0):.2f}:d=0.20"
    )
    run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            source,
            "-vf",
            video_filter,
            "-t",
            f"{duration:.2f}",
            "-an",
            "-r",
            str(FPS),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )


def render_final(segments: list[tuple[Path, float]], output: Path) -> None:
    norm = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS"
    )
    filters: list[str] = []
    for index, (_, trim_start) in enumerate(segments):
        filters.append(
            f"[{index}:v]trim=start={max(trim_start, 0):.2f},"
            f"setpts=PTS-STARTPTS,{norm}[v{index}]"
        )

    filters.append(
        "".join(f"[v{index}]" for index in range(len(segments)))
        + f"concat=n={len(segments)}:v=1:a=0,format=yuv420p[vout]"
    )
    cmd = ["ffmpeg", "-y"]
    for input_path, _ in segments:
        cmd.extend(["-i", str(input_path)])
    cmd.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[vout]",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    run(cmd)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", default="/tmp/imac-demo-video")
    parser.add_argument("--part1", default="/tmp/imac-demo-video/part1-before.webm")
    parser.add_argument("--part2", default="/tmp/imac-demo-video/part2-request.webm")
    parser.add_argument("--part3", default="/tmp/imac-demo-video/part3-after.webm")
    parser.add_argument("--output", required=True)
    parser.add_argument("--intro", default=DEFAULT_INTRO)
    parser.add_argument("--transition1", default=DEFAULT_TRANSITION_1)
    parser.add_argument("--transition2", default=DEFAULT_TRANSITION_2)
    parser.add_argument("--trim-start", type=float, default=TRIM_START_SECONDS)
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    part1 = Path(args.part1)
    part2 = Path(args.part2)
    part3 = Path(args.part3)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    for path in (part1, part2, part3):
        if not path.exists():
            raise SystemExit(f"Missing input clip: {path}")

    intro_ass = work_dir / "intro.ass"
    transition1_ass = work_dir / "transition1.ass"
    transition2_ass = work_dir / "transition2.ass"
    intro_video = work_dir / "intro-animated.mp4"
    transition1_video = work_dir / "transition1-animated.mp4"
    transition2_video = work_dir / "transition2-animated.mp4"

    write_ass(intro_ass, [line for line in args.intro.split("|") if line], INTRO_SECONDS)
    render_transition(intro_ass, intro_video, INTRO_SECONDS)
    write_ass(transition1_ass, [args.transition1], TRANSITION_1_SECONDS)
    write_ass(
        transition2_ass,
        [line for line in args.transition2.split("|") if line],
        TRANSITION_2_SECONDS,
    )
    render_transition(transition1_ass, transition1_video, TRANSITION_1_SECONDS)
    render_transition(transition2_ass, transition2_video, TRANSITION_2_SECONDS)

    segments = [
        (intro_video, 0.0),
        (part1, args.trim_start),
        (transition1_video, 0.0),
        (part2, args.trim_start),
        (transition2_video, 0.0),
        (part3, args.trim_start),
    ]
    render_final(segments, output)
    print(output)


if __name__ == "__main__":
    main()
