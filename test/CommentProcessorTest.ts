import { CommentProcessor } from "../src/CommentProcessor";
import { IssuesGetCommentResponse } from "@octokit/rest";

import { expect } from 'chai';

describe('CommentProcessor', () => {
    it("should construct", () => {
        new CommentProcessor({} as any);
    });
    it("should return a simple event for a simple body", () => {
        const cp = new CommentProcessor({} as any);
        const result = cp.getEventBodyForComment({
            html_url: "https://github.com/fakeissues/12345",
            body: "Hello!",
            id: 12345,
        } as IssuesGetCommentResponse);
        expect(result).to.deep.equal({
            msgtype: "m.text",
            body: "Hello!",
            format: "org.matrix.custom.html",
            formatted_body: "<p>Hello!</p>\n",
            external_url: "https://github.com/fakeissues/12345",
            "uk.half-shot.matrix-github.comment": {
                id: 12345,
            }
        })
    })
});