package kube

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestDeploymentNeedsRecreate(t *testing.T) {
	one := int32(1)
	three := int32(3)
	vol := []corev1.Volume{{Name: "data"}}

	cases := []struct {
		name     string
		replicas *int32
		volumes  []corev1.Volume
		strategy appsv1.DeploymentStrategyType
		want     bool
	}{
		// The bug: single-replica game server with save data, still rolling.
		{"rolling single replica with volume", &one, vol, appsv1.RollingUpdateDeploymentStrategyType, true},
		// An unset strategy IS RollingUpdate — the API server defaults it,
		// and this is the shape the affected generators emitted.
		{"unset strategy counts as rolling", &one, vol, "", true},
		{"unset replicas defaults to one", nil, vol, appsv1.RollingUpdateDeploymentStrategyType, true},

		// Already fixed, or out of scope.
		{"already recreate", &one, vol, appsv1.RecreateDeploymentStrategyType, false},
		{"scaled out is deliberate", &three, vol, appsv1.RollingUpdateDeploymentStrategyType, false},
		{"stateless companion", &one, nil, appsv1.RollingUpdateDeploymentStrategyType, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &appsv1.Deployment{
				ObjectMeta: metav1.ObjectMeta{Name: "valheim", Namespace: nsGamectl},
				Spec: appsv1.DeploymentSpec{
					Replicas: tc.replicas,
					Strategy: appsv1.DeploymentStrategy{Type: tc.strategy},
					Template: corev1.PodTemplateSpec{
						Spec: corev1.PodSpec{Volumes: tc.volumes},
					},
				},
			}
			if got := deploymentNeedsRecreate(d); got != tc.want {
				t.Errorf("deploymentNeedsRecreate = %v, want %v", got, tc.want)
			}
		})
	}
}

// The detector and the apply-time normalizer must agree, or the UI nags
// about instances a redeploy wouldn't change (or stays silent about ones it
// would). Both go through NeedsRecreateStrategy.
func TestDetectorMatchesNormalizer(t *testing.T) {
	for _, single := range []bool{true, false} {
		for _, vols := range []bool{true, false} {
			want := NeedsRecreateStrategy(single, vols)

			replicas := int32(3)
			if single {
				replicas = 1
			}
			var volumes []corev1.Volume
			if vols {
				volumes = []corev1.Volume{{Name: "data"}}
			}
			d := &appsv1.Deployment{Spec: appsv1.DeploymentSpec{
				Replicas: &replicas,
				Strategy: appsv1.DeploymentStrategy{Type: appsv1.RollingUpdateDeploymentStrategyType},
				Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Volumes: volumes}},
			}}
			if got := deploymentNeedsRecreate(d); got != want {
				t.Errorf("single=%v vols=%v: detector=%v normalizer=%v", single, vols, got, want)
			}
		}
	}
}
