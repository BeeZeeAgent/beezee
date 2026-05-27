import * as React from "react";
import { ChevronDown } from "lucide-react";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ children, style, ...props }, ref) => (
  <div style={{ position: "relative", display: "block", width: "100%" }}>
    <select
      ref={ref}
      style={{
        ...style,
        appearance: "none",
        WebkitAppearance: "none",
        paddingRight: 28,
        width: "100%",
      }}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      size={14}
      style={{
        position: "absolute",
        right: 9,
        top: "50%",
        transform: "translateY(-50%)",
        pointerEvents: "none",
        color: "#71717a",
      }}
    />
  </div>
));
Select.displayName = "Select";

export { Select };
