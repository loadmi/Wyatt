
export async function getResponse(messages: any[]): Promise<string> {
    const response = await fetch('https://text.pollinations.ai/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messages,
            model: 'openai-fast',
            reasoning_effort: 'minimal',
        })
    });

    const data = await response.text();
    return data;
};
