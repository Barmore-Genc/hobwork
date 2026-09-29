// Parses hobwork.json: JSON that may have comments and trailing commas. Throws
// a SyntaxError with the line and column of the first problem.
export function parseHobworkJson(text: string): unknown
