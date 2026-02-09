# Nines Infra Terraform (Skeleton)

This folder contains a minimal Terraform skeleton to scaffold global routing and security:

- Route 53 hosted zone for your domain
- AWS Global Accelerator (for global, static anycast IPs)
- WAFv2 Web ACL (attach to CloudFront/GA as needed)
- Placeholder ALB (regional)
- ACM certificate (DNS validation)

Variables:

- `region`: AWS region
- `domain_name`: Root domain to manage (e.g., example.com)
- `public_subnets`: List of public subnet IDs for the ALB
- `alb_sg`: Security group ID for the ALB
- `accel_name`: Optional accelerator name

Usage:

1. Configure AWS credentials.
2. Create a `terraform.tfvars` with your values.
3. Initialize and plan:

```
terraform init
terraform plan -var region=us-east-1 -var domain_name=example.com -var public_subnets=["subnet-xxx","subnet-yyy"] -var alb_sg=sg-zzz
```

Notes:

- This is a starting point; you will need to attach listeners, targets, CloudFront distributions, and Route 53 records according to your deployment.
- Consider adding per-region edge broadcaster ASGs and attaching them via GA/Route53.
