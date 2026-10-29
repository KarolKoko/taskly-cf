import { describe, test, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { DueBadge } from './DueBadge';


// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:
//   test(name, fn, timeout) - https://jestjs.io/docs/api#testname-fn-timeout
//   describe(name, fn) - https://jestjs.io/docs/api#describename-fn

describe("DueBadge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test("renders nothing when !label", () => {
    const label = "";
    const urgent = false;
    const { container } = render(<DueBadge label={label} urgent={urgent} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("renders when label and urgent", () => {
    const label = "Sample label";
    const urgent = true;
    const { container } = render(<DueBadge label={label} urgent={urgent} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(container).toHaveTextContent(label);
  });

  test("renders when label and !(urgent)", () => {
    const label = "Sample label";
    const urgent = false;
    const { container } = render(<DueBadge label={label} urgent={urgent} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(container).toHaveTextContent(label);
  });
});
